# Integration note: stub vs. a production service

The stub is a deliberately thin model of a production document-protection service
(PPAD). This note explains what each stub endpoint stands for in a real
deployment and what is simplified, so your reasoning transfers — without leaning
on any one vendor's internal schema.

## Endpoint mapping

| Stub endpoint | What it represents in production | How it's simplified |
|---------------|----------------------------------|---------------------|
| `GET /v1/files/:id` | protected-file metadata (owner, sharing mode, status) | in-memory record instead of a datastore |
| `GET /v1/files/:id/access` | the recipient allow list for a file | returns the seeded recipients directly |
| `POST /v1/files/:id/read` | **license / decryption-key issuance** | there is usually no "read plaintext" endpoint — files decrypt **client-side**, so a "read" is the viewer obtaining a license/key, gated by the allow list. The stub returns a license stand-in, never ciphertext. |
| `GET /v1/files/:id/audit` | a query over the audit event log | reads the in-memory event list |
| `POST /v1/files/:id/audit` | emitting an audit event | in production, events are emitted by services, not POSTed by a client; exposed here so your layer can record decisions it makes *before* calling `/read` |
| `POST .../recipients/:uid/revoke` | revoking a recipient's access | flips a recipient's status; a real system would also tombstone the grant, and may be able to revoke the whole file |
| `POST .../recipients/:uid/restore` | re-granting access | convenience for testing in-flight revocation |
| `GET /.well-known/jwks.json` | the IdP's published JWKS | served by the stub only so you can validate offline |

## Identity, auth, and tenancy

| Concept | Stub | Production (generic) |
|---------|------|----------------------|
| Tenant scope | `x-workspace-id: ws_acme` header | a workspace/tenant identifier carried per request |
| Service auth | `Authorization: Bearer <service-key>` | a service credential (bearer token or API key) |
| User id | `user_id` (`usr_alice`) | the service's own internal user identifier; emails may be stored hashed, so email is a weak join key |
| File status | `active` / `revoked` | a lifecycle status on the file |

## Two resource apps — the cross-app boundary

The kit runs **two** resource apps behind one IdP: PPAD (`:4010`) and a minimal
**App B** (`:4011`), each with its own audience and resource id (see
`identity-fixtures/issuer-config.json` → `resources`). This is what makes it
*Cross* App Access rather than single-app JWT validation:

- An assertion's `aud`/`resource` bind it to exactly one app. A token minted for
  PPAD must be **rejected** by App B, and vice versa — the tool enforces this by
  validating the audience against the *target* resource before any read.
- App B is intentionally tiny (read-only, one file, a one-entry allow list). All
  the composition depth — agent-vs-human allow list, revocation, attribution —
  lives on PPAD. App B exists only to make the cross-app boundary concrete.

In production these would be separate services the same IdP brokers access to.

## Sharing modes

- **`explicit`** — named recipients on the allow list (restricted mode).
- **`public`** — anyone with the link (link mode). The stub models this via `file_public_brochure`.

This `public` vs `explicit` split is the stretch-goal "link mode vs restricted
mode" distinction. Production services may have additional modes (e.g. domain-based
auto-grant); they're out of scope here, but worth a sentence in your write-up —
does an agent inherit a non-explicit grant on its principal's behalf?

## Audit attribution — the real constraint

The audit model exposes a **single** actor field (`user_id`) plus a JSON
`event_payload`, a `resource_type`/`resource_id`, and a `correlation_id`. There is
no second "acting agent" field. Attributing a read to **both** the human and the
agent therefore forces a modelling choice; the stub's convention is:

- `user_id` → the human principal (the on-behalf-of subject)
- `event_payload.actor` → the agent (`client_id`, name)
- `event_payload.on_behalf_of` → the principal again, explicitly
- `correlation_id` → the assertion `jti`

You may model it differently — but justify it against this single-actor-field
reality, not against an idealised schema.

## The composition mismatch (the crux)

The allow list is keyed on a human **`user_id`**. An ID-JAG assertion identifies
the acting agent by its **`client_id`**, which has **no home in the allow-list
model today**. That is the gap the assignment asks you to close: does the agent
ride entirely on the human's `user_id` (inheritance — the `client_id` appears only
in audit), or do you extend the model with an agent-policy dimension keyed on
`client_id`? The stub does not decide this for you — it only enforces the human
dimension.
