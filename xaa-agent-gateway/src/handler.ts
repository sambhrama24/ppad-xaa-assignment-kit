/**
 * The one function behind the MCP tool:
 *
 *   validate assertion (for the TARGET app)   → fail ⇒ rejected, stub untouched
 *     → map claims to PPAD identities (aud_sub → principal, client_id → agent)
 *       → agent overlay (composition policy)   → veto ⇒ denied, audited by us
 *         → governed read against the stub     → 200 granted / 403 denied
 *
 * Guarantees:
 *   - A validation failure NEVER reaches a stub (the `rejected` invariant).
 *   - Every read forwards BOTH the human principal and the agent, so the stub's
 *     single-actor audit event carries dual attribution.
 *   - Nothing throws to the caller: all paths return a structured ReadResult.
 *
 * Identity mapping (justified in WRITEUP.md):
 *   - principal = `aud_sub` (the resource's OWN user id — the allow-list key);
 *     `email` is a weaker fallback; the IdP-namespace `sub` is never the join key.
 *   - agent = `client_id` (spec-REQUIRED). `act` is non-normative (draft §9.7)
 *     and is used only as a display-name hint, never for authorization.
 */
import { loadConfig, resourceConfig, type Config, type ResourceConfig } from "./config.js";
import { AssertionError, validateAssertion, type RejectCode } from "./validate.js";

export interface ReadArgs {
  assertion: string;
  resource?: string; // "ppad" | "appb", default "ppad"
  fileId: string;
}

export interface ReadResult {
  /**
   * granted  — assertion valid, composition allows, stub read succeeded.
   * denied   — assertion valid, but access refused (human not allowed, or the
   *            agent overlay vetoed the agent).
   * rejected — assertion validation failed (incl. wrong app). Stub NEVER called.
   */
  outcome: "granted" | "denied" | "rejected";
  code: "ok" | "principal_not_authorized" | "agent_not_approved" | "file_not_found" | "upstream_error" | RejectCode;
  file_id: string;
  audit_event_id?: string;
  /** Human-readable detail for logs / the MCP text block. */
  message?: string;
}

const READ_REASON = "mcp.read_protected_file";

export async function readProtectedFile(args: ReadArgs, cfg: Config = loadConfig()): Promise<ReadResult> {
  const { fileId } = args;
  const resourceName = args.resource ?? "ppad";

  try {
    // 1) Resolve the target app, then validate the assertion against IT. Any
    //    failure (incl. unknown resource) ⇒ rejected; no stub is contacted.
    const target = resourceConfig(cfg, resourceName);
    if (!target) {
      throw new AssertionError("unknown_resource", `Unknown resource '${resourceName}' (expected 'ppad' or 'appb').`);
    }
    const claims = await validateAssertion(args.assertion, cfg, target);

    // 2) Map claims onto PPAD's identities (see header comment).
    const body = {
      principal: { user_id: claims.aud_sub ?? null, email: claims.email ?? null },
      agent: { client_id: claims.client_id!, name: claims.act?.name ?? null },
      assertion: { iss: claims.iss ?? null, jti: claims.jti ?? null },
      reason: READ_REASON,
    };

    // 3) Composition policy — the agent overlay. An empty approved set means
    //    pure inheritance; otherwise a disapproved agent is denied BEFORE
    //    /read, and we record that decision in PPAD's audit log ourselves
    //    (App B has no audit surface).
    const agentApproved = cfg.approvedAgents.size === 0 || cfg.approvedAgents.has(body.agent.client_id);
    if (!agentApproved) {
      let auditId: string | undefined;
      if (resourceName === "ppad") {
        const audit = await stubPost(target, cfg, `/v1/files/${encodeURIComponent(fileId)}/audit`, {
          ...body,
          decision: "denied",
          deny_reason: "agent_not_approved",
          event_type: "read_denied",
        });
        auditId = audit.body?.audit_event_id;
      }
      return {
        outcome: "denied",
        code: "agent_not_approved",
        file_id: fileId,
        audit_event_id: auditId,
        message: `Agent '${body.agent.client_id}' is not approved to act on a principal's behalf.`,
      };
    }

    // 4) Governed read. The stub enforces the human allow list (the floor an
    //    agent can never exceed) and writes the dual-attributed audit event.
    const res = await stubPost(target, cfg, `/v1/files/${encodeURIComponent(fileId)}/read`, body);

    if (res.status === 200 && res.body?.status === "license_granted") {
      return {
        outcome: "granted",
        code: "ok",
        file_id: res.body.file_id ?? fileId,
        audit_event_id: res.body.audit_event_id,
        message: "License granted.",
      };
    }
    if (res.status === 403) {
      // Human not on the allow list, or revoked. Stub already audited it.
      return {
        outcome: "denied",
        code: "principal_not_authorized",
        file_id: fileId,
        audit_event_id: res.body?.audit_event_id,
        message: res.body?.error?.message ?? "Principal is not authorized for this file.",
      };
    }
    if (res.status === 404) {
      return { outcome: "denied", code: "file_not_found", file_id: fileId, message: "File not found." };
    }
    // 400/401/5xx… — an operational problem on our side of the boundary.
    return {
      outcome: "denied",
      code: "upstream_error",
      file_id: fileId,
      message: `Unexpected stub response (${res.status}): ${res.body?.error?.message ?? "unknown"}`,
    };
  } catch (e) {
    // Validation failures ⇒ rejected (stub never touched). Anything unexpected
    // is caught here too, so no raw exception ever reaches the caller.
    if (e instanceof AssertionError) {
      return { outcome: "rejected", code: e.code, file_id: fileId, message: e.message };
    }
    return {
      outcome: "rejected",
      code: "malformed_assertion",
      file_id: fileId,
      message: `Assertion could not be processed: ${(e as Error).message}`,
    };
  }
}

/** POST to a resource stub with the service credential + tenant header. */
async function stubPost(
  target: ResourceConfig,
  cfg: Config,
  path: string,
  json: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${target.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.serviceKey}`,
      "x-workspace-id": cfg.workspaceId,
      "content-type": "application/json",
    },
    body: JSON.stringify(json),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
