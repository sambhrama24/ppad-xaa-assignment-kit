/**
 * PPAD-like resource stub.
 *
 * Models ONLY the surface the assignment needs: protected files, an allow list
 * (explicit + public sharing), recipient revocation, a governed "read" (license /
 * decryption-key issuance, since decryption happens client-side), and an audit
 * log. See ../../INTEGRATION-NOTE.md for how this maps to a production service.
 *
 * Enforcement boundary (deliberate): the stub enforces the recipient model — a
 * read succeeds only if the HUMAN principal is currently allowed. It does
 * NOT gate on the agent; it only records the agent in the audit trail. Composing
 * the agent dimension on top is the candidate's job.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { buildEvent } from "./audit";
import { createAppBApp } from "./appb";
import {
  addEvent,
  getFile,
  getRecipient,
  getUserByEmail,
  getUserById,
  listEvents,
  setRecipientStatus,
  workspaceId,
} from "./state";
import type { ProtectedFile, ReadRequest } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const jwks = readFileSync(join(here, "..", "..", "identity-fixtures", "jwks.json"), "utf8");

const SERVICE_KEY = process.env.STUB_SERVICE_KEY ?? "dev-stub-service-key";
const WORKSPACE_HEADER = "x-workspace-id";

const err = (code: string, message: string) => ({ error: { code, message } });

/** Resolve the principal the candidate's service claims, preferring user_id. */
function resolvePrincipalId(body: ReadRequest): string | null {
  if (body.principal?.user_id && getUserById(body.principal.user_id)) return body.principal.user_id;
  if (body.principal?.email) {
    const u = getUserByEmail(body.principal.email);
    if (u) return u.user_id;
  }
  return null;
}

/** The recipient-model decision. Pure: agent identity is intentionally ignored. */
function principalIsAllowed(file: ProtectedFile, userId: string | null): boolean {
  if (file.file_status !== "active") return false;
  if (file.sharing_mode === "public") return true;
  if (!userId) return false;
  const r = getRecipient(file, userId);
  return !!r && r.status === "active";
}

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "ppad-stub" }));

  // Public JWKS — lets candidates validate via URL instead of reading the file.
  app.get("/.well-known/jwks.json", (c) => {
    c.header("content-type", "application/json");
    return c.body(jwks);
  });

  // --- service auth + tenant scoping for everything under /v1 ---
  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${SERVICE_KEY}`) {
      return c.json(err("unauthenticated", "Missing or invalid stub service key."), 401);
    }
    const ws = c.req.header(WORKSPACE_HEADER);
    if (!ws) return c.json(err("missing_workspace", `Header ${WORKSPACE_HEADER} is required.`), 400);
    if (ws !== workspaceId()) return c.json(err("unknown_workspace", `Unknown workspace: ${ws}`), 404);
    await next();
  });

  // File metadata.
  app.get("/v1/files/:fileId", (c) => {
    const file = getFile(c.req.param("fileId"));
    if (!file) return c.json(err("file_not_found", "No such file."), 404);
    return c.json({
      file_id: file.file_id,
      name: file.name,
      owner_user_id: file.owner_user_id,
      sharing_mode: file.sharing_mode,
      file_status: file.file_status,
    });
  });

  // Who currently has access (the allow list).
  app.get("/v1/files/:fileId/access", (c) => {
    const file = getFile(c.req.param("fileId"));
    if (!file) return c.json(err("file_not_found", "No such file."), 404);
    return c.json({
      file_id: file.file_id,
      sharing_mode: file.sharing_mode,
      file_status: file.file_status,
      recipients: file.recipients.map((r) => ({
        user_id: r.user_id,
        email: r.email,
        status: r.status,
        addition_method: r.addition_method,
        added_at: r.added_at,
        removed_at: r.removed_at ?? null,
      })),
    });
  });

  // Governed read == license/decryption-key issuance, gated by the allow list.
  app.post("/v1/files/:fileId/read", async (c) => {
    const fileId = c.req.param("fileId");
    let body: ReadRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("invalid_body", "Request body must be JSON."), 400);
    }
    if (!body.principal || (!body.principal.user_id && !body.principal.email)) {
      return c.json(err("invalid_body", "principal.user_id or principal.email is required."), 400);
    }
    if (!body.agent || !body.agent.client_id) {
      return c.json(err("invalid_body", "agent.client_id is required (the acting agent)."), 400);
    }

    const file = getFile(fileId);
    const resolvedUserId = resolvePrincipalId(body);

    const recordAndDeny = (code: string, message: string, httpStatus: 403 | 404) => {
      addEvent(
        buildEvent({
          type: "read_denied",
          fileId,
          workspaceId: workspaceId(),
          body,
          decision: "denied",
          denyReason: code,
          resolvedUserId,
        }),
      );
      return c.json(err(code, message), httpStatus);
    };

    if (!file) return recordAndDeny("file_not_found", "No such file.", 404);
    if (!principalIsAllowed(file, resolvedUserId)) {
      return recordAndDeny(
        "principal_not_authorized",
        "The human principal is not currently allowed to read this file.",
        403,
      );
    }

    const event = buildEvent({
      type: "read_granted",
      fileId,
      workspaceId: workspaceId(),
      body,
      decision: "granted",
      resolvedUserId,
    });
    addEvent(event);

    return c.json({
      file_id: file.file_id,
      status: "license_granted",
      // Decryption happens client-side; the stub returns a license stand-in, not plaintext.
      license: { license_id: event.event_id, issued_at: event.occurred_time, expires_in_seconds: 300 },
      content_preview: {
        type: "stub_license_preview",
        text: `Decryption license issued for "${file.name}". (Stub fixture — no real ciphertext.)`,
      },
      audit_event_id: event.event_id,
    });
  });

  // Read the audit trail for a file.
  app.get("/v1/files/:fileId/audit", (c) => {
    const file = getFile(c.req.param("fileId"));
    if (!file) return c.json(err("file_not_found", "No such file."), 404);
    return c.json({ file_id: file.file_id, events: listEvents(file.file_id) });
  });

  // Append a candidate-authored audit event (e.g. an agent-policy denial the
  // candidate's layer made before it ever called /read).
  app.post("/v1/files/:fileId/audit", async (c) => {
    const fileId = c.req.param("fileId");
    const file = getFile(fileId);
    if (!file) return c.json(err("file_not_found", "No such file."), 404);
    let body: ReadRequest & { decision?: "granted" | "denied"; deny_reason?: string; event_type?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("invalid_body", "Request body must be JSON."), 400);
    }
    const event = buildEvent({
      type: body.event_type === "read_denied" ? "read_denied" : "read_granted",
      fileId,
      workspaceId: workspaceId(),
      body,
      decision: body.decision === "denied" ? "denied" : "granted",
      denyReason: body.deny_reason,
      resolvedUserId: resolvePrincipalId(body),
    });
    addEvent(event);
    return c.json({ audit_event_id: event.event_id }, 201);
  });

  // Revoke / restore a recipient (drives the "revoked principal is denied" and
  // "revocation blocks an in-flight read" cases).
  app.post("/v1/files/:fileId/recipients/:userId/revoke", (c) => {
    const r = setRecipientStatus(c.req.param("fileId"), c.req.param("userId"), "revoked", new Date().toISOString());
    if (!r.ok) return c.json(err(r.reason, "Cannot revoke."), 404);
    return c.json({ status: "revoked", file_id: c.req.param("fileId"), user_id: c.req.param("userId") });
  });

  app.post("/v1/files/:fileId/recipients/:userId/restore", (c) => {
    const r = setRecipientStatus(c.req.param("fileId"), c.req.param("userId"), "active", new Date().toISOString());
    if (!r.ok) return c.json(err(r.reason, "Cannot restore."), 404);
    return c.json({ status: "active", file_id: c.req.param("fileId"), user_id: c.req.param("userId") });
  });

  return app;
}

// Only listen when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4010);
  serve({ fetch: createApp().fetch, port });
  console.log(`PPAD stub listening on http://localhost:${port}`);
  console.log(`  JWKS:   http://localhost:${port}/.well-known/jwks.json`);
  console.log(`  health: http://localhost:${port}/health`);

  // App B — the second resource app, for the cross-app dimension.
  const appbPort = Number(process.env.APPB_PORT ?? 4011);
  serve({ fetch: createAppBApp().fetch, port: appbPort });
  console.log(`App B stub listening on http://localhost:${appbPort} (audience https://auth.appb.test)`);
}
