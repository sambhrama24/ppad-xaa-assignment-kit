/**
 * Mint CLI.
 *
 *   npm run mint -- --scenario valid-alice-agent     # one token -> .tmp/tokens/
 *   npm run mint:all                                 # every scenario -> .tmp/tokens/
 *   npm run mint:commit                              # every scenario -> sample-tokens/ (committed)
 *
 * The authoritative way to get a fresh, currently-valid token is `npm run mint`.
 * Committed sample tokens are decodable snapshots: the negative ones fail by
 * design; the positive ones are minted long-lived so the kit works out of the box.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { mintToken, scenarioNames, SCENARIOS } from "./mint";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const out: { scenario?: string; all: boolean; commit: boolean } = { all: false, commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--commit") out.commit = true;
    else if (a === "--scenario") out.scenario = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const commit = args.commit;
const outDir = commit ? join(here, "sample-tokens") : join(here, "..", ".tmp", "tokens");
mkdirSync(outDir, { recursive: true });

// Committed positive tokens get a 1-year ttl so they don't rot the day they're
// generated. Negative tokens carry the same ttl (only their intended defect
// should cause rejection); the `expired` scenario overrides ttl to the past.
const ttl = commit ? 365 * 24 * 3600 : 3600;

const names = args.all || commit ? scenarioNames() : [args.scenario ?? "valid-alice-agent"];

const summary: string[] = [];
for (const name of names) {
  const token = await mintToken(name, { ttl });
  writeFileSync(join(outDir, `${name}.jwt`), token + "\n");
  const header = decodeProtectedHeader(token);
  const claims = decodeJwt(token);
  summary.push(`- ${name}  [alg=${header.alg} kid=${header.kid ?? "-"}]  expected: ${SCENARIOS[name].expected}`);
  if (!args.all && !commit) {
    console.log(`\n${name}`);
    console.log(`  expected: ${SCENARIOS[name].expected}`);
    console.log(`  header:   ${JSON.stringify(header)}`);
    console.log(`  claims:   ${JSON.stringify(claims, null, 2)}`);
    console.log(`\n${token}\n`);
  }
}

console.log(`\nWrote ${names.length} token(s) to ${outDir}`);
if (args.all || commit) console.log(summary.join("\n"));
