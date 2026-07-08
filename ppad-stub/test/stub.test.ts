/**
 * Substrate tests: prove the PPAD stub itself behaves. These are NOT the
 * candidate's tests — they verify the kit we hand out. Run with `npm test`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server";
import { reset } from "../src/state";

const app = createApp();

const HEADERS = {
  authorization: "Bearer dev-stub-service-key",
  "x-workspace-id": "ws_acme",
  "content-type": "application/json",
};

const RESEARCH = { client_id: "client_research_assistant", name: "Acme Research Assistant" };

// Node's fetch types return `unknown` from .json(); these are fixtures, so read loosely.
const body = async (res: Response): Promise<any> => res.json();

function read(fileId: string, payload: unknown) {
  return app.request(`/v1/files/${fileId}/read`, { method: "POST", headers: HEADERS, body: JSON.stringify(payload) });
}
function audit(fileId: string) {
  return app.request(`/v1/files/${fileId}/audit`, { headers: HEADERS });
}

beforeEach(() => reset());

describe("health & jwks", () => {
  it("reports healthy", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect((await body(res)).status).toBe("ok");
  });

  it("serves a JWKS with the fixture kid", async () => {
    const res = await app.request("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    const jwks = await body(res);
    expect(jwks.keys[0].kid).toBe("ppad-xaa-fixture-2026");
    expect(jwks.keys[0].kty).toBe("RSA");
  });
});

describe("service auth + tenant scoping", () => {
  it("rejects calls without the service key", async () => {
    const res = await app.request("/v1/files/file_board_pack");
    expect(res.status).toBe(401);
  });

  it("rejects calls without the workspace header", async () => {
    const res = await app.request("/v1/files/file_board_pack", {
      headers: { authorization: "Bearer dev-stub-service-key" },
    });
    expect(res.status).toBe(400);
  });
});

describe("governed read enforces the PPAD recipient model", () => {
  it("grants an active recipient and attributes BOTH agent and principal", async () => {
    const res = await read("file_board_pack", {
      principal: { user_id: "usr_alice", email: "alice@acme.test" },
      agent: RESEARCH,
      assertion: { iss: "https://idp.acme.test/oauth2/default", jti: "jti_test_1" },
      reason: "mcp.read_protected_file",
    });
    expect(res.status).toBe(200);
    expect((await body(res)).status).toBe("license_granted");

    const events = (await body(await audit("file_board_pack"))).events;
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("read_granted");
    expect(events[0].user_id).toBe("usr_alice"); // principal in the actor column
    expect(events[0].event_payload.actor.agent_client_id).toBe("client_research_assistant"); // agent in payload
    expect(events[0].correlation_id).toBe("jti_test_1");
  });

  it("denies a principal who is not on the allow list, and audits the attempt", async () => {
    const res = await read("file_board_pack", {
      principal: { user_id: "usr_bob", email: "bob@acme.test" },
      agent: RESEARCH,
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("principal_not_authorized");

    const events = (await body(await audit("file_board_pack"))).events;
    expect(events[0].event_type).toBe("read_denied");
    expect(events[0].event_payload.actor.agent_client_id).toBe("client_research_assistant");
  });

  it("denies a revoked principal", async () => {
    const res = await read("file_board_pack", {
      principal: { user_id: "usr_charlie", email: "charlie@acme.test" },
      agent: RESEARCH,
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("principal_not_authorized");
  });

  it("grants any principal on a public file", async () => {
    const res = await read("file_public_brochure", {
      principal: { user_id: "usr_bob", email: "bob@acme.test" },
      agent: RESEARCH,
    });
    expect(res.status).toBe(200);
  });

  it("does NOT gate on the agent — an unapproved agent for an allowed human still reads", async () => {
    // The stub only enforces the human dimension. Gating the agent is the
    // candidate's composition layer, not the stub's.
    const res = await read("file_board_pack", {
      principal: { user_id: "usr_alice" },
      agent: { client_id: "client_unapproved_agent", name: "Unapproved Agent" },
    });
    expect(res.status).toBe(200);
  });
});

describe("revocation", () => {
  it("blocks a read after the recipient is revoked, and restores access", async () => {
    const ok1 = await read("file_board_pack", { principal: { user_id: "usr_alice" }, agent: RESEARCH });
    expect(ok1.status).toBe(200);

    const rev = await app.request("/v1/files/file_board_pack/recipients/usr_alice/revoke", {
      method: "POST",
      headers: HEADERS,
    });
    expect(rev.status).toBe(200);

    const denied = await read("file_board_pack", { principal: { user_id: "usr_alice" }, agent: RESEARCH });
    expect(denied.status).toBe(403);

    await app.request("/v1/files/file_board_pack/recipients/usr_alice/restore", { method: "POST", headers: HEADERS });
    const ok2 = await read("file_board_pack", { principal: { user_id: "usr_alice" }, agent: RESEARCH });
    expect(ok2.status).toBe(200);
  });
});

describe("candidate-authored audit append", () => {
  it("accepts an agent-policy denial event from the candidate's layer", async () => {
    const res = await app.request("/v1/files/file_board_pack/audit", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        event_type: "read_denied",
        decision: "denied",
        deny_reason: "agent_not_approved",
        principal: { user_id: "usr_alice" },
        agent: { client_id: "client_unapproved_agent" },
      }),
    });
    expect(res.status).toBe(201);
    const events = (await body(await audit("file_board_pack"))).events;
    expect(events[0].event_payload.deny_reason).toBe("agent_not_approved");
  });
});

describe("file metadata & access listing", () => {
  it("returns file metadata", async () => {
    const res = await app.request("/v1/files/file_board_pack", { headers: HEADERS });
    expect(res.status).toBe(200);
    const f = await body(res);
    expect(f.owner_user_id).toBe("usr_owner");
    expect(f.sharing_mode).toBe("explicit");
    expect(f.file_status).toBe("active");
  });

  it("404s an unknown file", async () => {
    const res = await app.request("/v1/files/file_nope", { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("lists recipients with their status", async () => {
    const res = await app.request("/v1/files/file_board_pack/access", { headers: HEADERS });
    const a = await body(res);
    const byId = Object.fromEntries(a.recipients.map((r: any) => [r.user_id, r.status]));
    expect(byId.usr_alice).toBe("active");
    expect(byId.usr_charlie).toBe("revoked");
  });
});

describe("read input validation", () => {
  it("400s when principal is missing", async () => {
    const res = await read("file_board_pack", { agent: RESEARCH });
    expect(res.status).toBe(400);
  });

  it("400s when agent is missing", async () => {
    const res = await read("file_board_pack", { principal: { user_id: "usr_alice" } });
    expect(res.status).toBe(400);
  });

  it("404s a read of an unknown file (and never grants)", async () => {
    const res = await read("file_nope", { principal: { user_id: "usr_alice" }, agent: RESEARCH });
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("file_not_found");
  });
});

describe("principal resolution by email", () => {
  it("resolves an allowed recipient by email alone", async () => {
    const res = await read("file_board_pack", { principal: { email: "alice@acme.test" }, agent: RESEARCH });
    expect(res.status).toBe(200);
  });

  it("denies a non-recipient resolved by email", async () => {
    const res = await read("file_board_pack", { principal: { email: "bob@acme.test" }, agent: RESEARCH });
    expect(res.status).toBe(403);
  });
});
