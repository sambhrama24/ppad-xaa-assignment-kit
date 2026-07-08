/**
 * App B — a second, deliberately minimal resource service.
 *
 * It exists ONLY to make the "Cross App" part of XAA concrete: one IdP issues
 * assertions for BOTH PPAD and App B, each scoped to its own audience/resource.
 * A candidate's tool must route per-resource and reject an assertion scoped to
 * the other app (audience binding).
 *
 * App B has no audit/revoke/access surface — that depth stays on PPAD. It only
 * proves an agent can act across apps with per-app assertions, and gives the
 * cross-app negative tests something real to hit.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

const SERVICE_KEY = process.env.STUB_SERVICE_KEY ?? "dev-stub-service-key";
const WORKSPACE_HEADER = "x-workspace-id";
const WORKSPACE_ID = "ws_acme";

// Minimal allow list: Alice may read App B's file; nobody else.
const FILES: Record<string, { name: string; allow: string[] }> = {
  appb_doc_1: { name: "Project Alpha Notes.appb", allow: ["usr_alice"] },
};

const err = (code: string, message: string) => ({ error: { code, message } });

export function createAppBApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "appb-stub" }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${SERVICE_KEY}`) {
      return c.json(err("unauthenticated", "Missing or invalid stub service key."), 401);
    }
    if (c.req.header(WORKSPACE_HEADER) !== WORKSPACE_ID) {
      return c.json(err("unknown_workspace", `Header ${WORKSPACE_HEADER} must be ${WORKSPACE_ID}.`), 400);
    }
    await next();
  });

  app.post("/v1/files/:fileId/read", async (c) => {
    const fileId = c.req.param("fileId");
    let body: { principal?: { user_id?: string }; agent?: { client_id?: string } };
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("invalid_body", "Request body must be JSON."), 400);
    }
    const file = FILES[fileId];
    if (!file) return c.json(err("file_not_found", "No such file."), 404);
    if (!body.principal?.user_id || !file.allow.includes(body.principal.user_id)) {
      return c.json(err("principal_not_authorized", "The principal is not allowed to read this App B file."), 403);
    }
    const id = `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    return c.json({
      file_id: fileId,
      status: "license_granted",
      license: { license_id: id, expires_in_seconds: 300 },
      content_preview: { type: "stub_license_preview", text: `Decryption license issued for "${file.name}" by App B.` },
      audit_event_id: id,
    });
  });

  return app;
}
