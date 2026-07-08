/**
 * Mint library — the local fake IdP.
 *
 * Produces ID-JAG-style assertions following draft-ietf-oauth-identity-
 * assertion-authz-grant-04. The claim set is documented in `claims.md`; every
 * claim is labelled there as draft-required, draft-optional, or fixture-only.
 *
 * Both the CLI (`mint-token.ts`) and the contract tests import from here, so
 * tests can mint FRESH tokens at run time and never trip over a stale `exp`.
 */
import { SignJWT, importPKCS8 } from "jose";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "issuer-config.json"), "utf8"));
const seed = JSON.parse(readFileSync(join(here, "..", "ppad-stub", "seed.json"), "utf8"));

const privatePem = readFileSync(join(here, "keys", "private.pem"), "utf8");
const roguePem = readFileSync(join(here, "keys", "rogue-private.pem"), "utf8");

type SeedUser = { user_id: string; idp_sub: string; email: string; name: string; status: string };
type SeedAgent = { client_id: string; name: string; status: string };

const userByKey = (id: string): SeedUser => {
  const u = seed.users.find((x: SeedUser) => x.user_id === id);
  if (!u) throw new Error(`seed user not found: ${id}`);
  return u;
};
const agentByKey = (id: string): SeedAgent => {
  const a = seed.agents.find((x: SeedAgent) => x.client_id === id);
  if (!a) throw new Error(`seed agent not found: ${id}`);
  return a;
};

export type Claims = Record<string, unknown>;

type ResourceCfg = { audience: string; resource: string; url: string };
const PPAD: ResourceCfg = cfg.resources.ppad;
const APPB: ResourceCfg = cfg.resources.appb;

/**
 * A neutral, spec-shaped ID-JAG payload for `principal` acted on by `agent`,
 * bound to one resource app (`res`). `aud`/`resource` are what tie the token to
 * a single app — that binding is the "Cross App" boundary.
 */
function base(
  principal: SeedUser,
  agent: SeedAgent,
  now: number,
  ttl: number,
  res: ResourceCfg = PPAD,
  scope = "ppad.read",
): Claims {
  return {
    // --- draft-04 REQUIRED ---
    iss: cfg.issuer, // IdP authorization server
    sub: principal.idp_sub, // End-User identifier in the IdP's namespace
    aud: res.audience, // the target Resource Authorization Server (NOT the API)
    client_id: agent.client_id, // the agent's OAuth client => the agent identity
    jti: `jti_${principal.user_id}_${agent.client_id}_${now}`,
    iat: now,
    exp: now + ttl,
    // --- draft-04 OPTIONAL ---
    nbf: now,
    resource: res.resource, // the protected resource/API (RFC 8707)
    aud_sub: principal.user_id, // the Resource AS's id for the End-User (== the resource's user id)
    tenant: seed.org_id, // multi-tenant issuer context
    email: principal.email,
    scope, // least-privilege hint: read, not share/revoke
    // `act` is OPTIONAL and NOT normatively processed by draft-04. It is here as
    // a fixture convention only; the spec-grounded agent id is `client_id`.
    act: { sub: agent.client_id, name: agent.name },
  };
}

const alice = () => userByKey("usr_alice");
const bob = () => userByKey("usr_bob");
const charlie = () => userByKey("usr_charlie");
const research = () => agentByKey("client_research_assistant");
const unapproved = () => agentByKey("client_unapproved_agent");

type Scenario = {
  description: string;
  /** Expected outcome when this token is used against the kit, for docs/tests. */
  expected: string;
  /** Which key signs it. "rogue" => signature will not verify against the JWKS. */
  signWith?: "real" | "rogue";
  /** Override the JWT header `kid`. */
  kid?: string;
  /** "none" => emit an unsigned `alg:none` token (classic JWT footgun). */
  alg?: "none";
  build: (now: number, ttl: number) => Claims;
};

export const SCENARIOS: Record<string, Scenario> = {
  "valid-alice-agent": {
    description: "Approved recipient (Alice) + research agent. Authorized for file_board_pack.",
    expected: "granted",
    build: (now, ttl) => base(alice(), research(), now, ttl),
  },
  "valid-bob-agent": {
    description: "Bob is not on any allow list + research agent.",
    expected: "denied: principal_not_authorized",
    build: (now, ttl) => base(bob(), research(), now, ttl),
  },
  "valid-charlie-agent": {
    description: "Charlie was revoked from the files + research agent.",
    expected: "denied: principal_not_authorized (revoked)",
    build: (now, ttl) => base(charlie(), research(), now, ttl),
  },
  "valid-unapproved-agent": {
    description: "Approved recipient (Alice) but an UNAPPROVED agent.",
    expected: "depends on your composition model (inherit => allow; independent allow-list => deny)",
    build: (now, ttl) => base(alice(), unapproved(), now, ttl),
  },
  "valid-alice-appb": {
    description: "Alice + research agent, but scoped to App B (audience https://auth.appb.test).",
    expected: "granted at App B (appb_doc_1); REJECTED if presented to PPAD — cross-app binding",
    build: (now, ttl) => base(alice(), research(), now, ttl, APPB, "appb.read"),
  },
  "wrong-audience": {
    description: "Valid signature, but aud is a different resource AS.",
    expected: "rejected before any PPAD read: invalid audience",
    build: (now, ttl) => ({ ...base(alice(), research(), now, ttl), aud: "https://auth.attacker.example" }),
  },
  expired: {
    description: "Valid signature/issuer/audience, but exp is in the past.",
    expected: "rejected before any PPAD read: expired",
    build: (now) => ({ ...base(alice(), research(), now, 3600), iat: now - 3600, nbf: now - 3600, exp: now - 1800 }),
  },
  "unknown-issuer": {
    description: "Valid signature, but iss is not the configured IdP.",
    expected: "rejected before any PPAD read: invalid issuer",
    build: (now, ttl) => ({ ...base(alice(), research(), now, ttl), iss: "https://evil-idp.example" }),
  },
  "missing-act": {
    description: "Valid token with NO act claim. client_id still identifies the agent.",
    expected: "granted (a robust validator keys the agent on client_id, not act)",
    build: (now, ttl) => {
      const c = base(alice(), research(), now, ttl);
      delete (c as Record<string, unknown>).act;
      return c;
    },
  },
  "invalid-signature": {
    description: "Structurally valid, correct kid, but signed by a key not in the JWKS.",
    expected: "rejected before any PPAD read: signature verification fails",
    signWith: "rogue",
    build: (now, ttl) => base(alice(), research(), now, ttl),
  },
  "unknown-kid": {
    description: "Signed by the real key but the header kid is not in the JWKS.",
    expected: "rejected before any PPAD read: no matching key",
    kid: "kid-not-in-jwks",
    build: (now, ttl) => base(alice(), research(), now, ttl),
  },
  "alg-none": {
    description: "Unsigned alg:none token (the classic JWT bypass).",
    expected: "rejected before any PPAD read: alg not allowed",
    alg: "none",
    build: (now, ttl) => base(alice(), research(), now, ttl),
  },
};

export type ScenarioName = keyof typeof SCENARIOS;

export const scenarioNames = (): string[] => Object.keys(SCENARIOS);

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export interface MintOptions {
  /** Seconds since epoch to treat as "now". Defaults to the real current time. */
  now?: number;
  /** Token lifetime in seconds (ignored by the `expired` scenario). */
  ttl?: number;
}

export async function mintToken(name: string, opts: MintOptions = {}): Promise<string> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}. Known: ${scenarioNames().join(", ")}`);

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttl ?? 3600;
  const claims = scenario.build(now, ttl);

  if (scenario.alg === "none") {
    // jose refuses to "sign" alg:none, so hand-build it.
    return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.`;
  }

  const pem = scenario.signWith === "rogue" ? roguePem : privatePem;
  const key = await importPKCS8(pem, "RS256");
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: scenario.kid ?? cfg.kid, typ: "JWT" }).sign(key);
}

export { cfg as issuerConfig };
