/**
 * Fixture-integrity tests: prove the mint -> JWKS -> validate path behaves as the
 * assignment depends on. This guards the token set against regressions (key
 * rotation, mint.ts edits, jose bumps). Runs with `npm test`.
 *
 * `verify()` is exactly what a candidate's validator should do: pin the
 * algorithm and check issuer + audience + expiry + signature against the JWKS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { issuerConfig, mintToken, scenarioNames } from "./mint";

const here = dirname(fileURLToPath(import.meta.url));
const jwks = createLocalJWKSet(JSON.parse(readFileSync(join(here, "jwks.json"), "utf8")));

const PPAD_AUD = issuerConfig.resources.ppad.audience;
const APPB_AUD = issuerConfig.resources.appb.audience;

const verify = (token: string, audience: string = PPAD_AUD) =>
  jwtVerify(token, jwks, { issuer: issuerConfig.issuer, audience, algorithms: ["RS256"] });

const ACCEPT = ["valid-alice-agent", "valid-bob-agent", "valid-charlie-agent", "valid-unapproved-agent", "missing-act"];

// Each negative must be rejected, AND for the right reason.
const REJECT: Record<string, RegExp> = {
  "wrong-audience": /aud/i,
  expired: /exp/i,
  "unknown-issuer": /iss/i,
  "invalid-signature": /signature/i,
  "unknown-kid": /key/i,
};

describe("token fixtures: minting", () => {
  it("mints every scenario as a 3-part JWT-ish token", async () => {
    for (const name of scenarioNames()) {
      const token = await mintToken(name);
      expect(token.split(".").length).toBe(3);
    }
  });
});

describe("token fixtures: accepted by a correct validator", () => {
  for (const name of ACCEPT) {
    it(`${name} verifies against the JWKS`, async () => {
      const { payload } = await verify(await mintToken(name));
      expect(payload.iss).toBe(issuerConfig.issuer);
      expect(payload.aud).toBe(PPAD_AUD);
      expect(payload.client_id).toBeTruthy(); // agent identity is always present
    });
  }
});

describe("token fixtures: rejected for the right reason", () => {
  for (const [name, reason] of Object.entries(REJECT)) {
    it(`${name} -> rejected (${reason})`, async () => {
      await expect(verify(await mintToken(name))).rejects.toThrow(reason);
    });
  }

  it("alg-none is unsigned and rejected by an alg-pinned validator", async () => {
    const token = await mintToken("alg-none");
    expect(decodeProtectedHeader(token).alg).toBe("none");
    await expect(verify(token)).rejects.toThrow();
  });
});

describe("token fixtures: claim shape", () => {
  it("valid-alice-agent carries the documented claims", async () => {
    const c = decodeJwt(await mintToken("valid-alice-agent")) as Record<string, any>;
    expect(c.client_id).toBe("client_research_assistant"); // spec-required agent id
    expect(c.aud_sub).toBe("usr_alice"); // == PPAD user_id
    expect(c.sub).toBe("00ualice000000000000"); // IdP subject, distinct from aud_sub
    expect(c.act.sub).toBe("client_research_assistant"); // fixture-only actor claim
    expect(c.resource).toBe(issuerConfig.resources.ppad.resource);
  });

  it("missing-act drops the act claim but keeps client_id", async () => {
    const c = decodeJwt(await mintToken("missing-act")) as Record<string, any>;
    expect(c.act).toBeUndefined();
    expect(c.client_id).toBe("client_research_assistant");
  });
});

describe("token fixtures: cross-app audience binding", () => {
  it("the App B token verifies against App B's audience", async () => {
    const { payload } = await verify(await mintToken("valid-alice-appb"), APPB_AUD);
    expect(payload.aud).toBe(APPB_AUD);
    expect(payload.resource).toBe(issuerConfig.resources.appb.resource);
  });

  it("a token bound to one app is rejected against the other (cross-app isolation)", async () => {
    // App B token must not verify for PPAD, and PPAD token must not verify for App B.
    await expect(verify(await mintToken("valid-alice-appb"), PPAD_AUD)).rejects.toThrow(/aud/i);
    await expect(verify(await mintToken("valid-alice-agent"), APPB_AUD)).rejects.toThrow(/aud/i);
  });
});
