/**
 * ID-JAG assertion validation — the security core.
 *
 * We validate the spec-required trust properties, against the *target*
 * resource, before anything touches a resource stub:
 *
 *   - signature: verified against the IdP's JWKS (RS256), offline or via jwks_uri
 *   - alg:       pinned to the configured algorithm — `alg:none` and any other
 *                algorithm are rejected (prevents unsigned/alg-confusion tokens)
 *   - kid:       an unknown key id fails the JWKS lookup → rejected
 *   - iss:       must equal the configured issuer
 *   - aud:       must equal the TARGET resource's audience (the cross-app
 *                binding — a PPAD token presented to App B fails here)
 *   - exp/nbf:   enforced by jose (small clock tolerance)
 *
 * Every failure becomes an AssertionError with a structured code. The handler
 * catches it and returns `{ outcome: "rejected", code }` — the stub is never
 * called, and no raw exception ever reaches the caller.
 */
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { readFileSync } from "node:fs";
import type { Config, ResourceConfig } from "./config.js";

/** Machine-readable reasons an assertion is rejected (validation failures). */
export type RejectCode =
  | "invalid_audience"
  | "expired"
  | "not_yet_valid"
  | "invalid_issuer"
  | "alg_not_allowed"
  | "signature_verification_failed"
  | "unknown_key_id"
  | "missing_claim"
  | "malformed_assertion"
  | "unknown_resource";

/** Thrown only inside validation; always caught by the handler. */
export class AssertionError extends Error {
  constructor(
    public readonly code: RejectCode,
    message: string,
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

/** ID-JAG claims we read (draft-ietf-oauth-identity-assertion-authz-grant-04). */
export interface IdJagClaims extends JWTPayload {
  client_id?: string; // REQUIRED — the spec-grounded agent identity
  aud_sub?: string; // the Resource AS's id for the user == PPAD's user_id
  email?: string;
  act?: { sub?: string; name?: string }; // NON-normative; display hint only
}

// One key set per config, memoised. createRemoteJWKSet caches HTTP responses.
const keyStoreCache = new WeakMap<Config, JWTVerifyGetKey>();

function keyStore(cfg: Config): JWTVerifyGetKey {
  let ks = keyStoreCache.get(cfg);
  if (!ks) {
    ks = cfg.jwksPath
      ? createLocalJWKSet(JSON.parse(readFileSync(cfg.jwksPath, "utf8"))) // offline
      : createRemoteJWKSet(new URL(cfg.jwksUri));
    keyStoreCache.set(cfg, ks);
  }
  return ks;
}

/**
 * Validate the assertion for a specific target resource. Returns the verified
 * claims on success; throws AssertionError (structured) on any failure.
 */
export async function validateAssertion(
  token: string,
  cfg: Config,
  target: ResourceConfig,
): Promise<IdJagClaims> {
  if (!token || typeof token !== "string") {
    throw new AssertionError("malformed_assertion", "Assertion is missing or not a string.");
  }

  let payload: IdJagClaims;
  try {
    const verified = await jwtVerify(token, keyStore(cfg), {
      issuer: cfg.issuer, // checks `iss`
      audience: target.audience, // checks `aud` against the TARGET app (cross-app gate)
      algorithms: [cfg.alg], // pins alg → rejects `alg:none` and any other alg
      clockTolerance: 5, // small skew allowance for exp/nbf
    });
    payload = verified.payload as IdJagClaims;
  } catch (e) {
    throw mapJoseError(e);
  }

  // `client_id` is REQUIRED by the draft and is our agent identity. jose does
  // not check custom claims, so enforce presence explicitly.
  if (!payload.client_id) {
    throw new AssertionError("missing_claim", "Assertion is missing the required `client_id` (agent identity).");
  }

  return payload;
}

/** Translate jose's typed errors into our structured, caller-safe codes. */
function mapJoseError(e: unknown): AssertionError {
  if (e instanceof joseErrors.JWTExpired) {
    return new AssertionError("expired", "Assertion has expired.");
  }
  if (e instanceof joseErrors.JWTClaimValidationFailed) {
    if (e.claim === "aud") return new AssertionError("invalid_audience", "Assertion audience does not match the target resource.");
    if (e.claim === "iss") return new AssertionError("invalid_issuer", "Assertion issuer is not trusted.");
    if (e.claim === "nbf") return new AssertionError("not_yet_valid", "Assertion is not yet valid (nbf).");
    return new AssertionError("missing_claim", `Assertion claim '${e.claim}' failed validation.`);
  }
  if (e instanceof joseErrors.JOSEAlgNotAllowed) {
    return new AssertionError("alg_not_allowed", "Assertion algorithm is not allowed (alg:none or unexpected alg).");
  }
  if (e instanceof joseErrors.JWKSNoMatchingKey) {
    return new AssertionError("unknown_key_id", "No JWKS key matches the assertion's key id (kid).");
  }
  if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new AssertionError("signature_verification_failed", "Assertion signature could not be verified.");
  }
  if (e instanceof joseErrors.JWSInvalid || e instanceof joseErrors.JWTInvalid) {
    return new AssertionError("malformed_assertion", "Assertion is malformed.");
  }
  // Unknown failure — stay generic; still a rejection, never a raw throw.
  return new AssertionError("malformed_assertion", `Assertion could not be validated: ${(e as Error).message}`);
}
