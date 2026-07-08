/**
 * Configuration. Three sources, deliberately separated:
 *
 *   1. The IdP contract (issuer, per-resource audience/resource/url, alg,
 *      jwks_uri) — read from identity-fixtures/issuer-config.json. This is the
 *      spec-relevant material and MUST NOT be hard-coded (ASSIGNMENT.md).
 *   2. Our policy defaults — config/default.json (the approved-agent overlay),
 *      so the composition decision holds out of the box.
 *   3. Environment overrides — stub service key, workspace id, APPROVED_AGENTS,
 *      optional local JWKS path / stub URL overrides.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ResourceName = "ppad" | "appb";

export interface ResourceConfig {
  /** The `aud` an assertion for this app must carry (its Resource AS). */
  audience: string;
  /** The `resource` (protected API) identifier for this app. */
  resource: string;
  /** Base URL of this app's stub. */
  url: string;
}

export interface Config {
  issuer: string;
  /** Signing algorithm we pin. Anything else (incl. `none`) is rejected. */
  alg: string;
  /** Remote JWKS endpoint (used unless jwksPath is set). */
  jwksUri: string;
  /** Local JWKS file for OFFLINE validation; wins over jwksUri when present. */
  jwksPath?: string;
  serviceKey: string;
  workspaceId: string;
  /** The agent overlay. Empty set ⇒ pure inheritance (any agent may act). */
  approvedAgents: Set<string>;
  resources: Record<ResourceName, ResourceConfig>;
}

const here = dirname(fileURLToPath(import.meta.url));

// Paths are resolved relative to this project's root (one level above
// src/ or dist/), so the same value works under tsx and compiled node.
const fromRoot = (p: string) => resolve(here, "..", p);

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuerConfigPath = fromRoot(env.ISSUER_CONFIG_PATH ?? "../identity-fixtures/issuer-config.json");
  const idp = readJson(issuerConfigPath);

  // Overlay policy: env wins when set (even set-but-empty ⇒ overlay off);
  // otherwise the shipped default applies.
  const approvedAgents = new Set<string>(
    env.APPROVED_AGENTS !== undefined
      ? env.APPROVED_AGENTS.split(",").map((s) => s.trim()).filter(Boolean)
      : (readJson(fromRoot("config/default.json")).approved_agents ?? []),
  );

  const pick = (name: ResourceName): ResourceConfig => {
    const r = idp.resources?.[name];
    if (!r) throw new Error(`issuer-config.json has no resource '${name}'`);
    const urlOverride = name === "ppad" ? env.STUB_PPAD_URL : env.STUB_APPB_URL;
    return { audience: r.audience, resource: r.resource, url: urlOverride ?? r.url };
  };

  return {
    issuer: idp.issuer,
    alg: idp.alg,
    jwksUri: idp.jwks_uri,
    jwksPath: env.JWKS_PATH ? fromRoot(env.JWKS_PATH) : undefined,
    serviceKey: env.STUB_SERVICE_KEY ?? "dev-stub-service-key",
    workspaceId: env.WORKSPACE_ID ?? "ws_acme",
    approvedAgents,
    resources: { ppad: pick("ppad"), appb: pick("appb") },
  };
}

/** Resolve a resource name to its config; undefined for an unknown name. */
export function resourceConfig(cfg: Config, name: string): ResourceConfig | undefined {
  return name === "ppad" || name === "appb" ? cfg.resources[name] : undefined;
}
