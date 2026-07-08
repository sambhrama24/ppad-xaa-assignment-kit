# xaa-agent-gateway

An MCP tool that lets an AI agent read protected files **on a user's behalf**, governed
by a signed identity assertion. It validates an **ID-JAG** token (the OAuth draft
underneath Okta Cross App Access), decides whether the *agent + human* pair is
authorized, performs one governed read (decryption-license issuance), and attributes
the read to **both** the agent and the human in the audit trail.

```
MCP client → ppad_read_protected_file → PPAD (:4010) or App B (:4011)
             validate assertion (audience of the TARGET app)
             → resolve principal (aud_sub) + agent (client_id)
             → agent policy → governed read → dual attribution
```

## What it does

- **Assertion validation** ([src/validate.ts](src/validate.ts), via `jose`):
  signature against the IdP JWKS, algorithm pinned to RS256 (`alg:none` and any
  other alg rejected), unknown `kid` rejected, issuer checked, `exp`/`nbf` enforced,
  and the audience checked against the **target** resource — a token minted for one
  app is rejected by the other. An invalid assertion never reaches a resource app.
- **Access composition** ([src/handler.ts](src/handler.ts)): *inheritance baseline +
  agent overlay.* The human principal (keyed on the token's `aud_sub` — the
  resource's own user id) must be currently on the file's allow list, enforced
  server-side, so an agent can never exceed its principal. On top, an approved-agent
  list keyed on `client_id` ([config/default.json](config/default.json)) vetoes
  unapproved agents even when their human is allowed.
- **Dual attribution:** every read forwards the human, the agent, and the assertion
  (`iss`, `jti`), so the audit event records the human in its `user_id` field and the
  agent in `event_payload.actor`, correlated to the exact token via `jti`. Agent-policy
  denials are recorded too, before any read is attempted.

## Run it

Requires Node ≥ 20.

```bash
# 1) start the resource apps (repo root)
npm install && npm start          # PPAD :4010, App B :4011

# 2) build the gateway (this directory)
cd xaa-agent-gateway
npm install && npm run build      # → dist/mcp-server.js
```

Point any MCP client at `node dist/mcp-server.js` (stdio). No env needed for the
default policy; see Configuration to override.

## Tool contract

`ppad_read_protected_file({ assertion, resource, fileId })` — `resource` is
`"ppad"` or `"appb"` (default `"ppad"`). Returns:

```jsonc
{
  "outcome": "granted" | "denied" | "rejected",
  "code": "ok",                    // or principal_not_authorized | agent_not_approved | expired | invalid_audience | ...
  "file_id": "file_board_pack",
  "audit_event_id": "evt_…"        // when a read was recorded
}
```

- `granted` — assertion valid, policy allows, license issued.
- `denied` — assertion valid, but access refused (human not on the allow list, or
  agent not approved).
- `rejected` — assertion failed validation (including wrong-app audience); **no
  resource app was called**.

Example:

```json
// call
{ "assertion": "<ID-JAG JWT>", "resource": "ppad", "fileId": "file_board_pack" }
// response
{ "outcome": "granted", "code": "ok", "file_id": "file_board_pack", "audit_event_id": "evt_ad8fa1c34dc9…" }
```

## Tests

```bash
npm test
```

- `tests/validate.test.ts` — offline unit tests (local JWKS, no network): every
  invalid-token class maps to the right rejection code; cross-app audience binding
  in both directions.
- `tests/handler.test.ts` — integration against the running resource apps: grant,
  deny (not on list / revoked / unapproved agent), cross-app rejection, dual
  attribution in the audit log, and in-flight revocation (revoke → blocked →
  restore → granted). Skips with a message if the apps aren't running.

The repo-root contract suite also runs against the built server:

```bash
CANDIDATE_MCP_CMD="node dist/mcp-server.js" \
CANDIDATE_MCP_CWD="$(pwd)/xaa-agent-gateway" \
npm run test:contract
```

## Configuration

Identity settings (issuer, per-app audience, JWKS location) come from
[identity-fixtures/issuer-config.json](../identity-fixtures/issuer-config.json);
everything else from env. Nothing is hard-coded.

| Var | Meaning | Default |
|-----|---------|---------|
| `ISSUER_CONFIG_PATH` | IdP contract (issuer, audiences, JWKS uri) | `../identity-fixtures/issuer-config.json` |
| `JWKS_PATH` | local JWKS file for offline signature validation (wins over the remote uri) | unset → fetch `jwks_uri` |
| `STUB_PPAD_URL` / `STUB_APPB_URL` | resource app base URLs | from issuer-config |
| `STUB_SERVICE_KEY` | service credential the resource apps expect | `dev-stub-service-key` |
| `WORKSPACE_ID` | tenant header | `ws_acme` |
| `APPROVED_AGENTS` | comma list of approved agent `client_id`s; `""` disables the overlay (pure inheritance) | from `config/default.json` |

## Design notes

- **Principal = `aud_sub`.** The allow list is keyed on the resource's own user id,
  which the assertion carries as `aud_sub`. `email` is a weak fallback; the
  IdP-namespace `sub` is never used as the join key.
- **Agent = `client_id`** (spec-required). The `act` claim is non-normative and is
  used only as a display-name hint, never for authorization.
- **Revocation:** a valid assertion authenticates *delegation*; it is never a cached
  authorization. Access is re-checked at read time, so revoking the human blocks the
  very next read even while the token is still cryptographically valid.
- **Not included:** token-exchange leg, `jti` replay cache, public-vs-explicit
  sharing nuance. See [WRITEUP.md](WRITEUP.md) for the full design rationale.

## Layout

```
src/
  mcp-server.ts   stdio MCP server; registers ppad_read_protected_file
  handler.ts      orchestration: resolve identities → agent policy → governed read
  validate.ts     ID-JAG validation: alg pin, iss, aud(target), exp/nbf, kid, signature
  config.ts       issuer config + policy defaults + env
config/
  default.json    shipped agent policy
  .env.example    env overrides
tests/            offline validation + integration
```
