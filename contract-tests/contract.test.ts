/**
 * Candidate-facing contract tests. They run against YOUR service, not the stub.
 *
 * Prereqs to run:
 *   1. Start the PPAD stub:           npm start
 *   2. Start your MCP server/service (pointed at the stub).
 *   3. Tell the harness how to reach it, then run the tests:
 *        CANDIDATE_MCP_CMD="node dist/mcp-server.js" npm run test:contract
 *      (or CANDIDATE_HTTP_URL=http://localhost:3000/read)
 *
 * Tokens are minted FRESH here, so `exp` never goes stale. Optionally set
 * PPAD_STUB_URL (default http://localhost:4010) to also assert dual attribution
 * in the stub's audit trail.
 *
 * With no candidate endpoint configured, the suite skips with a message rather
 * than failing — that's expected before you've built your service.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "../identity-fixtures/mint";
import { makeHarness, type Harness } from "./harness";

const STUB_URL = process.env.PPAD_STUB_URL ?? "http://localhost:4010";

let harness: Harness | null = null;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  harness = await makeHarness();
  if (!harness) return;
  for (const name of [
    "valid-alice-agent",
    "valid-bob-agent",
    "valid-charlie-agent",
    "valid-unapproved-agent",
    "wrong-audience",
    "expired",
    "alg-none",
    "invalid-signature",
    "unknown-kid",
    "unknown-issuer",
    "valid-alice-appb",
  ]) {
    tokens[name] = await mintToken(name);
  }
});

async function auditCount(fileId: string): Promise<number> {
  const res = await fetch(`${STUB_URL}/v1/files/${fileId}/audit`, {
    headers: { authorization: "Bearer dev-stub-service-key", "x-workspace-id": "ws_acme" },
  });
  const { events } = (await res.json()) as { events: unknown[] };
  return events.length;
}

afterAll(async () => {
  await harness?.close();
});

const maybe = process.env.CANDIDATE_MCP_CMD || process.env.CANDIDATE_HTTP_URL ? describe : describe.skip;

if (!process.env.CANDIDATE_MCP_CMD && !process.env.CANDIDATE_HTTP_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[contract-tests] skipped: set CANDIDATE_MCP_CMD or CANDIDATE_HTTP_URL to run against your service.\n",
  );
}

maybe("access decision", () => {
  it("authorized agent+principal is GRANTED", async () => {
    const r = await harness!.call(tokens["valid-alice-agent"], "file_board_pack");
    expect(r.outcome).toBe("granted");
  });

  it("principal not on the allow list is DENIED", async () => {
    const r = await harness!.call(tokens["valid-bob-agent"], "file_board_pack");
    expect(r.outcome).toBe("denied");
  });

  it("revoked principal is DENIED", async () => {
    const r = await harness!.call(tokens["valid-charlie-agent"], "file_employment_contract");
    expect(r.outcome).toBe("denied");
  });

  it("unapproved agent for an allowed human resolves per your model (granted OR denied, never rejected)", async () => {
    const r = await harness!.call(tokens["valid-unapproved-agent"], "file_board_pack");
    expect(["granted", "denied"]).toContain(r.outcome);
  });
});

maybe("assertion validation — never serves content", () => {
  it("wrong-audience token is REJECTED", async () => {
    const r = await harness!.call(tokens["wrong-audience"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
  });

  it("expired token is REJECTED", async () => {
    const r = await harness!.call(tokens["expired"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
  });

  it("alg:none token is REJECTED", async () => {
    const r = await harness!.call(tokens["alg-none"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
  });

  it("invalid-signature token is REJECTED", async () => {
    const r = await harness!.call(tokens["invalid-signature"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
  });

  it("unknown-kid token is REJECTED", async () => {
    const r = await harness!.call(tokens["unknown-kid"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
  });

  it("unknown-issuer token is REJECTED", async () => {
    const r = await harness!.call(tokens["unknown-issuer"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
  });

  it("a rejected assertion NEVER reaches the stub (no audit event written)", async () => {
    // Validating before calling PPAD is the contract: an invalid assertion must
    // not produce ANY stub interaction, not even a denied/read_denied row.
    const before = await auditCount("file_board_pack");
    const r = await harness!.call(tokens["wrong-audience"], "file_board_pack");
    expect(r.outcome).toBe("rejected");
    expect(await auditCount("file_board_pack")).toBe(before);
  });
});

maybe("cross-app access (XAA)", () => {
  it("the same agent+human reads App B with an App-B-scoped token", async () => {
    const r = await harness!.call(tokens["valid-alice-appb"], "appb_doc_1", "appb");
    expect(r.outcome).toBe("granted");
  });

  it("a PPAD-scoped token is REJECTED when used against App B (audience binding)", async () => {
    const r = await harness!.call(tokens["valid-alice-agent"], "appb_doc_1", "appb");
    expect(r.outcome).toBe("rejected");
  });

  it("an App-B-scoped token is REJECTED when used against PPAD (audience binding)", async () => {
    const r = await harness!.call(tokens["valid-alice-appb"], "file_board_pack", "ppad");
    expect(r.outcome).toBe("rejected");
  });
});

maybe("audit attribution", () => {
  it("a granted read records BOTH the agent and the human principal", async () => {
    await harness!.call(tokens["valid-alice-agent"], "file_board_pack");
    const res = await fetch(`${STUB_URL}/v1/files/file_board_pack/audit`, {
      headers: { authorization: "Bearer dev-stub-service-key", "x-workspace-id": "ws_acme" },
    });
    const { events } = (await res.json()) as { events: Array<Record<string, any>> };
    const granted = events.find((e) => e.event_payload?.decision === "granted");
    expect(granted, "expected a granted audit event").toBeTruthy();
    expect(granted!.user_id).toBe("usr_alice");
    expect(granted!.event_payload.actor.agent_client_id).toBe("client_research_assistant");
  });
});
