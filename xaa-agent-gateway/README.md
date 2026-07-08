# PPAD × XAA — agent-identity MCP tool

An MCP tool, `ppad_read_protected_file`, that sits between an AI client and the
PPAD / App B resource stubs. It **validates an ID-JAG (Cross App Access) assertion**,
applies a **composition policy** that decides whether an *agent* may act for a
*human*, performs one **governed read** (license issuance) against the correct
resource app, and attributes the read to **both** the agent and the human.

```
MCP client → ppad_read_protected_file → PPAD (:4010) or App B (:4011)
             validate assertion (audience for the TARGET app)
             → resolve principal (aud_sub) + agent (client_id)
             → agent overlay → governed read → dual attribution
```

The Part 1 decisions this implements are in **[WRITEUP.md](WRITEUP.md)**.

## What it does

- **Validates the assertion properly** ([src/validate.ts](src/validate.ts)) with `jose`:
  signature against the IdP JWKS, **algorithm pinned to RS256** (rejects `alg:none`
  and any other alg), **unknown `kid` rejected**, issuer checked, expiry/`nbf`
  enforced, and **audience checked against the *target* resource** — the cross-app
  binding. A PPAD token is rejected at App B and vice versa.
- **Never lets an invalid assertion reach a stub.** Validation happens first; a
  failure returns `outcome: "rejected"` and no stub call is made.
- **Composition policy** ([src/handler.ts](src/handler.ts)): *inheritance baseline + thin
  agent overlay.* The human principal (keyed on `aud_sub`) must be currently allowed
  — enforced server-side by the stub, so an agent can never exceed its principal. On
  top, a `client_id` allow list (shipped in [config/default.json](config/default.json),
  overridable via `APPROVED_AGENTS`) vetoes an unapproved agent even when its human
  is allowed — so `valid-unapproved-agent` is **denied out of the box**.
- **Dual attribution** in the stub's single-actor audit log: the read forwards the
  human (`user_id`), the agent (`client_id`, name), and the assertion (`iss`, `jti`)
  so the stub records `user_id` = human and `event_payload.actor` = agent. An
  overlay denial (which happens *before* `/read`) is recorded via the stub's
  `POST /audit`.

## Run it

Requires Node ≥ 20. From this directory:

```bash
npm install
npm run build            # → dist/mcp-server.js
```

The tool reads the IdP contract (issuer, per-app audience, JWKS) from the kit's
`identity-fixtures/issuer-config.json`, and its own settings from env. Copy
`config/.env.example` and adjust if needed. Nothing about the IdP or stubs is
hard-coded.

Start the kit's resource stubs (in the **kit root**, one level up):

```bash
cd ..
npm install && npm start        # PPAD :4010 + App B :4011
```

### Point the contract harness at this tool

From the **kit root**, with the stubs running:

```bash
CANDIDATE_MCP_CMD="node dist/mcp-server.js" \
CANDIDATE_MCP_CWD="$(pwd)/xaa-agent-gateway" \
npm run test:contract
# → 15 passed (no policy env needed — config/default.json ships the overlay)
```

### Point an MCP client at this tool

Command: `node dist/mcp-server.js` (cwd = this directory), transport **stdio**,
tool `ppad_read_protected_file`. No env needed for the default policy.

## Example call & response

Tool call:

```json
{ "name": "ppad_read_protected_file",
  "arguments": { "assertion": "<ID-JAG JWT>", "resource": "ppad", "fileId": "file_board_pack" } }
```

Responses (real output, default config):

```
granted          {"outcome":"granted","code":"ok","file_id":"file_board_pack","audit_event_id":"evt_…"}
denied(human)    {"outcome":"denied","code":"principal_not_authorized","file_id":"file_board_pack"}
denied(overlay)  {"outcome":"denied","code":"agent_not_approved","file_id":"file_board_pack","audit_event_id":"evt_…"}
rejected(exp)    {"outcome":"rejected","code":"expired","file_id":"file_board_pack"}
crossapp reject  {"outcome":"rejected","code":"invalid_audience","file_id":"appb_doc_1"}
appb granted     {"outcome":"granted","code":"ok","file_id":"appb_doc_1","audit_event_id":"evt_…"}
```

`outcome` is `granted | denied | rejected`; `rejected` always means the assertion
failed validation (including wrong app) and the stub was never called. `code` is a
machine-readable reason (not asserted by the harness, but useful).

## Tests

```bash
npm test                 # 29 tests: validate.test.ts (offline) + handler.test.ts (needs stubs up)
```

- `tests/validate.test.ts` — **offline** unit tests (local JWKS, no network): every
  invalid scenario maps to the right `rejected` code; alg:none / unknown-kid / bad
  signature; cross-app audience binding both directions.
- `tests/handler.test.ts` — **integration** vs the running stubs: granted / denied
  (not-on-list, revoked) / overlay-denied unapproved agent / cross-app rejection /
  dual attribution in the audit trail / **in-flight revocation** (revoke → read
  blocked → restore). Skips with a message if the stubs aren't running.

## Configuration ([config/.env.example](config/.env.example))

| Var | Meaning | Default |
|-----|---------|---------|
| `ISSUER_CONFIG_PATH` | IdP contract (issuer, audiences, JWKS uri) | `../identity-fixtures/issuer-config.json` |
| `JWKS_PATH` | local JWKS for **offline** signature validation (wins over the remote uri) | unset → fetch `jwks_uri` |
| `STUB_PPAD_URL` / `STUB_APPB_URL` | stub base URLs | from issuer-config |
| `STUB_SERVICE_KEY` | service credential the stub expects | `dev-stub-service-key` |
| `WORKSPACE_ID` | tenant header | `ws_acme` |
| `APPROVED_AGENTS` | comma list of `client_id`s allowed to act (the overlay); set to `""` to disable the overlay (pure inheritance) | from `config/default.json` (`client_research_assistant`) |

## Assumptions & trade-offs

- **Subject key = `aud_sub`.** PPAD's allow list is keyed on the resource's own user
  id, which the assertion carries as `aud_sub`. `email` is a weaker fallback; the
  IdP-namespace `sub` (`00u…`) is deliberately *not* used as the join key.
- **Agent identity = `client_id`** (spec-required). `act` is present in the fixtures
  but is non-normative (draft §9.7), so it is used only as a display-name hint, never
  for authorization — the `missing-act` token still succeeds.
- **Overlay is the default posture.** `config/default.json` ships an approved-agent
  list, so an unapproved agent is denied out of the box (`valid-unapproved-agent` →
  `denied` — the one outcome that is *our* call). Set `APPROVED_AGENTS=""` to fall
  back to pure inheritance.
- **Offline vs remote JWKS.** Both supported; offline (`JWKS_PATH`) matches XAA's
  "validate the assertion directly" posture and keeps unit tests network-free.
- **No token-exchange leg / no replay cache.** Simplified per the kit (we validate the
  ID-JAG directly). `jti` is recorded for correlation; a production build would add a
  short-TTL `jti` replay cache. Public-vs-explicit sharing and a live Okta mint are
  out of scope (noted in WRITEUP.md as next steps).
- **In-flight revocation** is resolved by the stub re-checking the allow list at
  `/read`: a valid assertion authenticates *delegation*, it is never a cached
  authorization.

## Layout

```
src/
  mcp-server.ts   stdio MCP server; registers ppad_read_protected_file
  handler.ts      orchestration: resolve identities → agent overlay → governed read → ReadResult
  validate.ts     ID-JAG validation (jose): alg pin, iss, aud(target), exp/nbf, kid, sig
  config.ts       issuer-config.json + config/default.json + env
config/
  default.json    shipped composition policy (approved agents)
  .env.example    env overrides
tests/            validate (offline) + handler (integration)
```
