# Fixture keys — LOCAL TEST USE ONLY

These RSA keys exist solely so this assignment kit can mint and verify
ID-JAG-style tokens offline. They are **not** Okta keys, **not** PPAD keys,
and must never be used outside this harness.

- `private.pem` — signs valid tokens (public half is published in `../jwks.json`).
- `public.pem` — SPKI form of the signing key.
- `rogue-private.pem` — deliberately absent from the JWKS; used only to forge
  the `invalid-signature` token so validators can prove they reject it.

JWKS `kid`: `ppad-xaa-fixture-2026`
