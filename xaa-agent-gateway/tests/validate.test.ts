/**
 * Unit tests for ID-JAG validation — fully OFFLINE (local JWKS, no stub, no
 * network). Every invalid scenario must map to `rejected` with the right code,
 * and every read path is proven never to touch a stub because these tests don't
 * run one.
 */
import { describe, expect, it } from "vitest";
import { mintToken } from "../../identity-fixtures/mint";
import { loadConfig, resourceConfig, type Config } from "../src/config.js";
import { AssertionError, validateAssertion } from "../src/validate.js";

const env = {
  ISSUER_CONFIG_PATH: "../identity-fixtures/issuer-config.json",
  JWKS_PATH: "../identity-fixtures/jwks.json", // offline validation
  APPROVED_AGENTS: "client_research_assistant",
} as unknown as NodeJS.ProcessEnv;

const cfg: Config = loadConfig(env);
const ppad = resourceConfig(cfg, "ppad")!;
const appb = resourceConfig(cfg, "appb")!;

async function expectReject(token: string | Promise<string>, code: string, target = ppad) {
  await expect(validateAssertion(await token, cfg, target)).rejects.toMatchObject({ code });
}

describe("ID-JAG validation (offline)", () => {
  it("accepts a well-formed PPAD assertion and exposes agent + subject", async () => {
    const claims = await validateAssertion(await mintToken("valid-alice-agent"), cfg, ppad);
    expect(claims.client_id).toBe("client_research_assistant");
    expect(claims.aud_sub).toBe("usr_alice");
  });

  it("accepts a token with no `act` claim (agent keyed on client_id, not act)", async () => {
    const claims = await validateAssertion(await mintToken("missing-act"), cfg, ppad);
    expect(claims.client_id).toBe("client_research_assistant");
  });

  it("rejects a wrong-audience token", () => expectReject(mintToken("wrong-audience"), "invalid_audience"));
  it("rejects an expired token", () => expectReject(mintToken("expired"), "expired"));
  it("rejects an unknown issuer", () => expectReject(mintToken("unknown-issuer"), "invalid_issuer"));
  it("rejects an invalid signature", () => expectReject(mintToken("invalid-signature"), "signature_verification_failed"));
  it("rejects an unknown kid", () => expectReject(mintToken("unknown-kid"), "unknown_key_id"));
  it("rejects alg:none", () => expectReject(mintToken("alg-none"), "alg_not_allowed"));

  it("rejects a garbage string without throwing to the caller", async () => {
    await expect(validateAssertion("not-a-jwt", cfg, ppad)).rejects.toBeInstanceOf(AssertionError);
  });

  describe("cross-app audience binding", () => {
    it("rejects a PPAD token presented to App B", async () => {
      await expectReject(await mintToken("valid-alice-agent"), "invalid_audience", appb);
    });
    it("rejects an App B token presented to PPAD", async () => {
      await expectReject(await mintToken("valid-alice-appb"), "invalid_audience", ppad);
    });
    it("accepts an App B token at App B", async () => {
      const claims = await validateAssertion(await mintToken("valid-alice-appb"), cfg, appb);
      expect(claims.aud).toBe(appb.audience);
    });
  });
});
