/**
 * Generates the local fixture signing key + JWKS for the fake IdP.
 *
 * Run once with `npm run setup`. Outputs (all committed to the repo on purpose,
 * so the kit works out of the box):
 *   identity-fixtures/keys/private.pem        - signs valid ID-JAG tokens
 *   identity-fixtures/keys/public.pem         - SPKI of the above
 *   identity-fixtures/keys/rogue-private.pem  - NOT in the JWKS; signs the
 *                                               invalid-signature scenario
 *   identity-fixtures/jwks.json               - public JWKS the stub serves at
 *                                               /.well-known/jwks.json
 *
 * Re-running rotates the keys. If you rotate, regenerate the sample tokens too
 * (`npm run mint:commit`), or the committed samples will no longer verify.
 */
import { generateKeyPair, exportPKCS8, exportSPKI, exportJWK } from "jose";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "identity-fixtures");
const keysDir = join(fixturesDir, "keys");

const cfg = JSON.parse(readFileSync(join(fixturesDir, "issuer-config.json"), "utf8"));

mkdirSync(keysDir, { recursive: true });

// Primary signing key — its public half goes into the JWKS.
const { publicKey, privateKey } = await generateKeyPair("RS256", {
  modulusLength: 2048,
  extractable: true,
});
const privatePem = await exportPKCS8(privateKey);
const publicPem = await exportSPKI(publicKey);
const jwk = await exportJWK(publicKey);
jwk.kid = cfg.kid;
jwk.alg = "RS256";
jwk.use = "sig";

// Rogue key — never published in the JWKS. Used to forge a validly-structured
// but unverifiable token for the invalid-signature negative scenario.
const rogue = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
const roguePem = await exportPKCS8(rogue.privateKey);

writeFileSync(join(keysDir, "private.pem"), privatePem);
writeFileSync(join(keysDir, "public.pem"), publicPem);
writeFileSync(join(keysDir, "rogue-private.pem"), roguePem);
writeFileSync(join(fixturesDir, "jwks.json"), JSON.stringify({ keys: [jwk] }, null, 2) + "\n");

writeFileSync(
  join(keysDir, "README.md"),
  [
    "# Fixture keys — LOCAL TEST USE ONLY",
    "",
    "These RSA keys exist solely so this assignment kit can mint and verify",
    "ID-JAG-style tokens offline. They are **not** Okta keys, **not** PPAD keys,",
    "and must never be used outside this harness.",
    "",
    "- `private.pem` — signs valid tokens (public half is published in `../jwks.json`).",
    "- `public.pem` — SPKI form of the signing key.",
    "- `rogue-private.pem` — deliberately absent from the JWKS; used only to forge",
    "  the `invalid-signature` token so validators can prove they reject it.",
    "",
    `JWKS \`kid\`: \`${cfg.kid}\``,
    "",
  ].join("\n"),
);

console.log(`Generated fixture keys + jwks.json (kid=${cfg.kid}).`);
console.log("Next: `npm run mint:commit` to (re)generate the sample tokens.");
