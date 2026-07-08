# PPAD × XAA assignment kit

A self-contained substrate for the agent-identity (Cross App Access) take-home: a
PPAD-like resource stub, a second resource app, a local fake IdP (JWKS + token
mint), sample ID-JAG tokens, and contract tests. You build **one MCP tool**
against it.

📄 **Candidate brief: [`ASSIGNMENT.md`](ASSIGNMENT.md).** This README is just the operating manual.

## Quickstart

Requires Node ≥ 20. No database or Docker needed.

```bash
npm install
npm start            # boots PPAD on :4010 and App B on :4011
```

Mint a fresh token and hit the stub:

```bash
npm run mint -- --scenario valid-alice-agent     # prints the token + decoded claims

curl -s -X POST http://localhost:4010/v1/files/file_board_pack/read \
  -H "authorization: Bearer dev-stub-service-key" \
  -H "x-workspace-id: ws_acme" -H "content-type: application/json" \
  -d '{"principal":{"user_id":"usr_alice"},"agent":{"client_id":"client_research_assistant"},"assertion":{"iss":"https://idp.acme.test/oauth2/default","jti":"jti_demo"}}'
# -> { "status": "license_granted", "audit_event_id": "evt_…", ... }
```

A non-recipient (`usr_bob`, or revoked `usr_charlie`) gets `403 principal_not_authorized`, still audited.
Keys + JWKS are committed, so it runs immediately; `npm run setup && npm run mint:commit` rotates them.

## Run the tests

```bash
npm test                                                          # substrate tests (no candidate service needed)
CANDIDATE_MCP_CMD="node dist/mcp-server.js" npm run test:contract  # acceptance tests vs YOUR service
#   or: CANDIDATE_HTTP_URL=http://localhost:3000/read
```

The contract suite mints fresh tokens and skips (with a message) until a candidate endpoint is set.

## What you build

One MCP tool (HTTP fallback allowed) sitting between the MCP client and the resource apps:

```
MCP client → YOUR tool → PPAD (:4010) or App B (:4011)
             validate assertion (audience for the TARGET app)
             → resolve principal + agent → apply composition policy → attribute the read
```

- The stub enforces only the **human** allow list. Whether an **agent** may act for
  that human is your call (Part 1), implemented here. The core mismatch: the allow
  list is keyed on a human `user_id`, while an ID-JAG agent is a `client_id` with no
  home in that model.
- **Cross-app (XAA):** one IdP, two apps, each with its own audience. A token is bound
  to one app — validate the audience against the **target** resource and reject a PPAD
  token used against App B (and vice versa).

See [`INTEGRATION-NOTE.md`](INTEGRATION-NOTE.md) for how the stub maps to a production service.

## Tool contract

`ppad_read_protected_file({ assertion, resource, fileId })` — `resource` is `"ppad"` or
`"appb"` (default `"ppad"`). Returns:

```jsonc
{
  "outcome": "granted" | "denied" | "rejected",  // rejected = invalid assertion (incl. wrong app); stub NEVER called
  "code": "ok",                                   // or principal_not_authorized | invalid_audience | expired | ...
  "file_id": "file_board_pack",
  "audit_event_id": "evt_…"                       // when a read happened
}
```

Return structured errors, not raw exceptions. Config — issuer/audience/JWKS live in
`identity-fixtures/issuer-config.json`; the stub URLs and service key are your service's
own config — comes from env. Don't hard-code it.

## Scenarios

| Token | Resource / file | Expected |
|-------|-----------------|----------|
| `valid-alice-agent` | ppad / `file_board_pack` | granted |
| `valid-bob-agent` | ppad / `file_board_pack` | denied (not on allow list) |
| `valid-charlie-agent` | ppad / `file_employment_contract` | denied (revoked) |
| `valid-unapproved-agent` | ppad / `file_board_pack` | your composition call |
| `valid-alice-appb` | appb / `appb_doc_1` | granted |
| `valid-alice-appb` | **ppad** | rejected (wrong app) |
| `valid-alice-agent` | **appb** | rejected (wrong app) |
| `wrong-audience` / `expired` / `unknown-issuer` / `invalid-signature` / `unknown-kid` / `alg-none` | any | rejected — never read |

Per-claim provenance and the full token list: [`identity-fixtures/claims.md`](identity-fixtures/claims.md).

## Layout

```
ASSIGNMENT.md         the candidate brief
ppad-stub/            resource stubs (Hono, in-memory): PPAD :4010 + App B :4011
  openapi.yaml  seed.json  src/  test/
identity-fixtures/    local fake IdP: issuer-config, jwks, keys/, mint.ts, sample-tokens/, claims.md
contract-tests/       acceptance tests vs YOUR service
INTEGRATION-NOTE.md   stub → production-service mapping
```

## Notes

- **Not** real PPAD encryption, the production API, or live Okta — local fixtures only.
- You validate the ID-JAG directly; no token-exchange leg (simplified from full XAA).
- "Read" = license/key issuance — decryption is client-side, so no plaintext is served.
- State is in-memory and resets on restart. All data is synthetic (`@acme.test`) — no real PII.
- ⚠️ `identity-fixtures/keys/` are LOCAL FIXTURE keys only — never use them outside this harness.
