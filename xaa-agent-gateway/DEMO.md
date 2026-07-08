# Live demo script (~8 minutes)

Run everything from the **kit root**. Keep this file open on the call.

## 0. Setup (before the call starts)

```bash
npm start                      # terminal 1 — stubs: PPAD :4010, App B :4011
cd xaa-agent-gateway && npm run build  # terminal 2 — make sure dist/ is fresh
```

## 1. Show a token (30s) — "this is what we're validating"

```bash
npm run mint -- --scenario valid-alice-agent
```

Point at the decoded claims: `client_id` (the agent), `aud_sub` (the human in
PPAD's namespace), `aud` (bound to ONE app), `exp` (short-lived).

## 2. The happy path + the composition call (2 min)

```bash
cat > /tmp/demo.mts <<'EOF'
import { mintToken } from "./identity-fixtures/mint";
import { readProtectedFile } from "./xaa-agent-gateway/src/handler.ts";
const show = async (label, scn, file, res = "ppad") => {
  const r = await readProtectedFile({ assertion: await mintToken(scn), resource: res, fileId: file });
  console.log(label.padEnd(34), JSON.stringify({ outcome: r.outcome, code: r.code }));
};
await show("alice + approved agent", "valid-alice-agent", "file_board_pack");
await show("bob (not on list)", "valid-bob-agent", "file_board_pack");
await show("charlie (revoked)", "valid-charlie-agent", "file_employment_contract");
await show("alice + UNAPPROVED agent", "valid-unapproved-agent", "file_board_pack");
EOF
cp /tmp/demo.mts _demo.mts && npx tsx _demo.mts && rm _demo.mts
```

Talking point: the first three are PPAD's human allow list (the floor). The
fourth is MY call — the agent overlay. Same allowed human, different agent, denied.

## 3. Validation rejections (1 min) — "bad tokens never touch PPAD"

Same pattern with scenarios: `expired`, `wrong-audience`, `invalid-signature`,
`alg-none`, `unknown-kid`. All → `rejected`. Talking point: `rejected` vs
`denied` is a contract — rejected means the stub was NEVER called, and the
harness proves it by checking the audit count doesn't move.

## 4. Cross-app boundary (1 min) — "the XAA part"

Scenarios: `valid-alice-appb` at `appb` (granted), `valid-alice-agent` at
`appb` (rejected), `valid-alice-appb` at `ppad` (rejected). Talking point:
same human, same agent, valid signature — the ONLY difference is which app the
token was minted for. `aud` binds a token to exactly one app.

## 5. Dual attribution (1 min) — "who really read the file"

```bash
curl -s http://localhost:4010/v1/files/file_board_pack/audit \
  -H "authorization: Bearer dev-stub-service-key" -H "x-workspace-id: ws_acme" \
  | python3 -m json.tool | head -40
```

Point at ONE event: `user_id` = the human (single actor column),
`event_payload.actor.agent_client_id` = the agent, `correlation_id` = the
token's `jti`. Both actors, one schema, traceable to the exact assertion.

## 6. In-flight revocation (1.5 min) — the closer

```bash
# revoke Alice
curl -s -X POST http://localhost:4010/v1/files/file_board_pack/recipients/usr_alice/revoke \
  -H "authorization: Bearer dev-stub-service-key" -H "x-workspace-id: ws_acme"
# re-run the alice read from step 2 → denied, with the SAME still-valid token
# restore
curl -s -X POST http://localhost:4010/v1/files/file_board_pack/recipients/usr_alice/restore \
  -H "authorization: Bearer dev-stub-service-key" -H "x-workspace-id: ws_acme"
```

Talking point: "A valid assertion authenticates the delegation — it is never a
cached authorization. Authorization is decided at read time, against live state."

## 7. The receipts (30s)

```bash
cd xaa-agent-gateway && npm test                          # 29 passed
cd .. && CANDIDATE_MCP_CMD="node dist/mcp-server.js" \
  CANDIDATE_MCP_CWD="$(pwd)/xaa-agent-gateway" npm run test:contract   # 15 passed
```

Talking point: contract suite passes with ZERO env vars — the composition
decision ships as the default, not as a flag someone has to remember.
