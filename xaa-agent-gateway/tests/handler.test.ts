/**
 * Integration tests for the composition slice, run in-process against the
 * running kit stubs (PPAD :4010 + App B :4011). Start them with `npm start`
 * in the kit root first; otherwise these skip with a message.
 *
 * These cover the required cases from ASSIGNMENT.md plus the agent overlay and
 * the in-flight-revocation stretch goal.
 */
import { describe, expect, it } from "vitest";
import { mintToken } from "../../identity-fixtures/mint";
import { loadConfig, type Config } from "../src/config.js";
import { readProtectedFile } from "../src/handler.js";

const PPAD = process.env.STUB_PPAD_URL ?? "http://localhost:4010";

const env = {
  ISSUER_CONFIG_PATH: "../identity-fixtures/issuer-config.json",
  JWKS_PATH: "../identity-fixtures/jwks.json",
  STUB_SERVICE_KEY: "dev-stub-service-key",
  WORKSPACE_ID: "ws_acme",
  APPROVED_AGENTS: "client_research_assistant",
} as unknown as NodeJS.ProcessEnv;

const cfg: Config = loadConfig(env);

const svc = { authorization: "Bearer dev-stub-service-key", "x-workspace-id": "ws_acme" };

// Health-check at MODULE LOAD (top-level await), before describe/it collection —
// so `when()` picks it/it.skip correctly. A beforeAll hook would run too late.
const stubUp = await fetch(`${PPAD}/health`)
  .then((r) => r.ok)
  .catch(() => false);
if (!stubUp) console.warn("\n[handler.test] skipped: start the kit stubs with `npm start` in the kit root.\n");

const when = () => (stubUp ? it : it.skip);

async function auditCount(fileId: string): Promise<number> {
  const res = await fetch(`${PPAD}/v1/files/${fileId}/audit`, { headers: svc });
  const { events } = (await res.json()) as { events: unknown[] };
  return events.length;
}
async function call(scenario: string, fileId: string, resource: "ppad" | "appb" = "ppad") {
  return readProtectedFile({ assertion: await mintToken(scenario), resource, fileId }, cfg);
}

describe("access decision", () => {
  when()("grants an authorized agent+principal", async () => {
    const r = await call("valid-alice-agent", "file_board_pack");
    expect(r.outcome).toBe("granted");
    expect(r.code).toBe("ok");
    expect(r.audit_event_id).toBeTruthy();
  });

  when()("denies a principal not on the allow list", async () => {
    const r = await call("valid-bob-agent", "file_board_pack");
    expect(r.outcome).toBe("denied");
    expect(r.code).toBe("principal_not_authorized");
  });

  when()("denies a revoked principal", async () => {
    const r = await call("valid-charlie-agent", "file_employment_contract");
    expect(r.outcome).toBe("denied");
    expect(r.code).toBe("principal_not_authorized");
  });

  when()("denies an unapproved agent even when its human is allowed (overlay)", async () => {
    const r = await call("valid-unapproved-agent", "file_board_pack");
    expect(r.outcome).toBe("denied");
    expect(r.code).toBe("agent_not_approved");
  });

  when()("overlay denial holds with the DEFAULT config (no env override)", async () => {
    // config/default.json ships the approved list, so the composition decision
    // is the out-of-the-box behaviour, not an env-var accident.
    const defaultCfg = loadConfig({ JWKS_PATH: "../identity-fixtures/jwks.json" } as NodeJS.ProcessEnv);
    const r = await readProtectedFile(
      { assertion: await mintToken("valid-unapproved-agent"), resource: "ppad", fileId: "file_board_pack" },
      defaultCfg,
    );
    expect(r.outcome).toBe("denied");
    expect(r.code).toBe("agent_not_approved");
  });

  when()("rejects an unknown resource name without calling any stub", async () => {
    const before = await auditCount("file_board_pack");
    const r = await readProtectedFile(
      { assertion: await mintToken("valid-alice-agent"), resource: "not-an-app", fileId: "file_board_pack" },
      cfg,
    );
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe("unknown_resource");
    expect(await auditCount("file_board_pack")).toBe(before);
  });
});

describe("assertion validation never reaches the stub", () => {
  for (const [scenario, code] of [
    ["wrong-audience", "invalid_audience"],
    ["expired", "expired"],
    ["unknown-issuer", "invalid_issuer"],
    ["invalid-signature", "signature_verification_failed"],
    ["unknown-kid", "unknown_key_id"],
    ["alg-none", "alg_not_allowed"],
  ] as const) {
    when()(`rejects ${scenario} and writes no audit event`, async () => {
      const before = await auditCount("file_board_pack");
      const r = await call(scenario, "file_board_pack");
      expect(r.outcome).toBe("rejected");
      expect(r.code).toBe(code);
      expect(await auditCount("file_board_pack")).toBe(before);
    });
  }
});

describe("cross-app boundary", () => {
  when()("grants an App B token at App B", async () => {
    const r = await call("valid-alice-appb", "appb_doc_1", "appb");
    expect(r.outcome).toBe("granted");
  });
  when()("rejects a PPAD token against App B", async () => {
    const r = await call("valid-alice-agent", "appb_doc_1", "appb");
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe("invalid_audience");
  });
  when()("rejects an App B token against PPAD", async () => {
    const r = await call("valid-alice-appb", "file_board_pack", "ppad");
    expect(r.outcome).toBe("rejected");
    expect(r.code).toBe("invalid_audience");
  });
});

describe("dual attribution", () => {
  when()("records BOTH the human and the agent on a granted read", async () => {
    await call("valid-alice-agent", "file_board_pack");
    const res = await fetch(`${PPAD}/v1/files/file_board_pack/audit`, { headers: svc });
    const { events } = (await res.json()) as { events: Array<Record<string, any>> };
    const granted = events.find((e) => e.event_payload?.decision === "granted");
    expect(granted?.user_id).toBe("usr_alice");
    expect(granted?.event_payload.actor.agent_client_id).toBe("client_research_assistant");
    expect(granted?.event_payload.on_behalf_of.user_id).toBe("usr_alice");
    expect(granted?.correlation_id).toBeTruthy(); // the assertion jti
  });
});

describe("in-flight revocation (stretch)", () => {
  when()("blocks a read the instant the principal is revoked, then restores", async () => {
    // baseline: Alice can read
    expect((await call("valid-alice-agent", "file_board_pack")).outcome).toBe("granted");
    // revoke Alice mid-flight
    await fetch(`${PPAD}/v1/files/file_board_pack/recipients/usr_alice/revoke`, { method: "POST", headers: svc });
    try {
      const denied = await call("valid-alice-agent", "file_board_pack");
      expect(denied.outcome).toBe("denied");
      expect(denied.code).toBe("principal_not_authorized");
    } finally {
      // restore so the suite is order-independent
      await fetch(`${PPAD}/v1/files/file_board_pack/recipients/usr_alice/restore`, { method: "POST", headers: svc });
    }
    expect((await call("valid-alice-agent", "file_board_pack")).outcome).toBe("granted");
  });
});
