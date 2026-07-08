# ID-JAG token fixture — claim reference

The sample tokens follow **draft-ietf-oauth-identity-assertion-authz-grant-04**
(the Identity Assertion JWT Authorization Grant that underpins Okta Cross App
Access). This file documents the exact shape and, for each claim, its
**provenance** — so you know what is mandated by the draft versus what is a
convenience of this harness.

> Provenance matters. Part of what we're looking for is whether you validate
> against the *spec-required* fields and treat the rest with appropriate
> caution. Don't hard-code a claim just because it appears in the fixture.

## Example payload (`valid-alice-agent`)

```json
{
  "iss": "https://idp.acme.test/oauth2/default",
  "sub": "00ualice000000000000",
  "aud": "https://auth.ppad.test",
  "client_id": "client_research_assistant",
  "jti": "jti_usr_alice_client_research_assistant_1782...",
  "iat": 1782360000,
  "exp": 1782363600,
  "nbf": 1782360000,
  "resource": "https://api.ppad.test/files",
  "aud_sub": "usr_alice",
  "tenant": "org_acme",
  "email": "alice@acme.test",
  "scope": "ppad.read",
  "act": { "sub": "client_research_assistant", "name": "Acme Research Assistant" }
}
```

Header: `{ "alg": "RS256", "kid": "ppad-xaa-fixture-2026", "typ": "JWT" }`

## Claim provenance

| Claim       | Provenance (draft-04)        | Meaning here | Notes |
|-------------|------------------------------|--------------|-------|
| `iss`       | **REQUIRED**                 | The IdP authorization server | Validate against configured issuer. |
| `sub`       | **REQUIRED**                 | The End-User in the IdP's namespace (`00u…`, Okta-style) | This is the IdP subject, **not** the resource's user id. |
| `aud`       | **REQUIRED**                 | The **Resource Authorization Server** for the target app (PPAD: `https://auth.ppad.test`, App B: `https://auth.appb.test`) | NOT the API. Validate against the **target resource's** audience — that's the cross-app binding. |
| `client_id` | **REQUIRED**                 | The agent's OAuth client at the resource AS | **This is the spec-grounded agent identity.** |
| `jti`       | **REQUIRED**                 | Unique token id | Basis for replay protection if you add it. |
| `iat`/`exp` | **REQUIRED**                 | Issued-at / expiry | Enforce `exp`. |
| `nbf`       | optional (JWT)               | Not-before | Present for completeness. |
| `resource`  | optional (draft, RFC 8707)   | The protected resource/API (`https://api.ppad.test/files`) | Distinct from `aud`. |
| `aud_sub`   | optional (draft §3.1)        | "The Resource AS's identifier for the End-User" | **Maps to the resource's internal user id** — the value the allow list is keyed on. |
| `tenant`    | optional (draft §3.1)        | Multi-tenant issuer context | Mapped to the tenant/org here. |
| `email`     | optional (draft §3.1)        | End-user email | Treat email as a hint, not the key — a resource may not store plaintext email. |
| `scope`     | optional (draft)             | Granted scope (`ppad.read`) | Least-privilege hint: read, not share/revoke. |
| `act`       | optional, **NOT normatively processed** (draft §9.7) | RFC 8693 actor: the agent acting for the subject | **Fixture convention.** The draft does not define processing for `act`/`actor_token`. Prefer `client_id`. |

### Subject resolution

You receive three identifiers for the human: `sub` (IdP), `aud_sub` (the resource
AS's id for the user), and `email`. Decide which one the resource's allow list is
keyed on and justify it. (In the stub, the allow list is keyed on `user_id`, i.e.
`aud_sub`. `email` resolves too, but it's the weaker key — a resource may not even
store plaintext email.)

## Token scenarios

`npm run mint -- --scenario <name>` mints any of these fresh (recommended).
Committed copies live in `sample-tokens/` (positive ones are minted ~1-year-lived
so the kit works out of the box; `expired` is genuinely in the past).

| Scenario | Signed? | Defect | Expected outcome |
|----------|---------|--------|------------------|
| `valid-alice-agent`     | real key | none | **granted** (Alice ∈ allow list of `file_board_pack`) |
| `valid-bob-agent`       | real key | none | **denied** — Bob is on no allow list |
| `valid-charlie-agent`   | real key | none | **denied** — Charlie was revoked |
| `valid-unapproved-agent`| real key | none | **your call** — allowed human, unapproved agent |
| `valid-alice-appb`      | real key | `aud` = App B | **granted** at App B (`appb_doc_1`); **rejected** at PPAD (cross-app) |
| `missing-act`           | real key | no `act` claim | **granted** — key the agent on `client_id` |
| `wrong-audience`        | real key | `aud` wrong | **rejected** (never read) |
| `expired`               | real key | `exp` past | **rejected** (never read) |
| `unknown-issuer`        | real key | `iss` wrong | **rejected** (never read) |
| `invalid-signature`     | **rogue key** | sig won't verify | **rejected** (never read) |
| `unknown-kid`           | real key | header `kid` not in JWKS | **rejected** (never read) |
| `alg-none`              | unsigned | `alg:none` | **rejected** (never read) |

> "valid-*" means the *signature/issuer/audience/expiry* are valid. Whether the
> read is **authorized** is a separate decision made after validation.
