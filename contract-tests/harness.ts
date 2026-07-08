/**
 * Test harness that talks to the CANDIDATE's service. Two transports:
 *
 *   MCP (preferred): set CANDIDATE_MCP_CMD to the command that starts your
 *       stdio MCP server, e.g.
 *         CANDIDATE_MCP_CMD="node dist/mcp-server.js"
 *       The harness calls the tool `ppad_read_protected_file` with
 *       { assertion, resource, fileId }. `resource` is "ppad" or "appb".
 *
 *   HTTP (fallback): set CANDIDATE_HTTP_URL to an endpoint that accepts
 *       POST { assertion, resource, fileId } and returns the same JSON shape.
 *
 * Required normalized result shape your tool/endpoint must return:
 *   {
 *     "outcome": "granted" | "denied" | "rejected",
 *     "code":    string,                 // "ok" | "principal_not_authorized" | "invalid_audience" | ...
 *     "file_id": string,
 *     "audit_event_id"?: string
 *   }
 *   - granted  : assertion valid AND your composition allows AND the stub read succeeded
 *   - denied   : assertion valid, but access refused (human not allowed, or agent not approved)
 *   - rejected : assertion validation failed — the stub was NEVER called
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ReadResult {
  outcome: "granted" | "denied" | "rejected";
  code: string;
  file_id?: string;
  audit_event_id?: string;
  [k: string]: unknown;
}

export interface Harness {
  call(assertion: string, fileId: string, resource?: string): Promise<ReadResult>;
  close(): Promise<void>;
}

const TOOL_NAME = "ppad_read_protected_file";

function coerce(raw: unknown): ReadResult {
  if (raw && typeof raw === "object" && "outcome" in (raw as object)) return raw as ReadResult;
  if (typeof raw === "string") {
    try {
      return coerce(JSON.parse(raw));
    } catch {
      /* fall through */
    }
  }
  throw new Error(`Candidate result was not the required JSON shape: ${JSON.stringify(raw)}`);
}

async function mcpHarness(cmd: string): Promise<Harness> {
  const [command, ...args] = cmd.split(" ").filter(Boolean);
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: process.env.CANDIDATE_MCP_CWD || process.cwd(),
  });
  const client = new Client({ name: "ppad-xaa-contract-tests", version: "1.0.0" });
  await client.connect(transport);
  return {
    async call(assertion, fileId, resource = "ppad") {
      const res = await client.callTool({ name: TOOL_NAME, arguments: { assertion, resource, fileId } });
      // Prefer structuredContent; otherwise parse the first text content block.
      const structured = (res as { structuredContent?: unknown }).structuredContent;
      if (structured) return coerce(structured);
      const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
      const text = content.find((b) => b.type === "text")?.text;
      return coerce(text);
    },
    async close() {
      await client.close();
    },
  };
}

function httpHarness(url: string): Harness {
  return {
    async call(assertion, fileId, resource = "ppad") {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assertion, resource, fileId }),
      });
      return coerce(await res.json());
    },
    async close() {},
  };
}

/** Returns a harness, or null when no candidate endpoint is configured. */
export async function makeHarness(): Promise<Harness | null> {
  if (process.env.CANDIDATE_MCP_CMD) return mcpHarness(process.env.CANDIDATE_MCP_CMD);
  if (process.env.CANDIDATE_HTTP_URL) return httpHarness(process.env.CANDIDATE_HTTP_URL);
  return null;
}
