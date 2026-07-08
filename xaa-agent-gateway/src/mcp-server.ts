#!/usr/bin/env node
/**
 * Stdio MCP server exposing a single tool:
 *
 *   ppad_read_protected_file({ assertion, resource?, fileId })
 *     → { outcome, code, file_id, audit_event_id? }
 *
 * We use the low-level Server API (no zod coupling) so we control the result
 * shape exactly: we return the ReadResult both as a JSON text block (which the
 * contract harness parses) and as `structuredContent` (which it prefers).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { readProtectedFile, type ReadResult } from "./handler.js";

const TOOL_NAME = "ppad_read_protected_file";

// Load config once at startup; fail loudly here (not per-call) if it's broken.
const config = loadConfig();

const server = new Server(
  { name: "ppad-xaa-mcp-tool", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        "Validate an ID-JAG (XAA) agent assertion for the target resource app and perform one " +
        "governed read (license issuance). Returns a normalized outcome of granted | denied | rejected.",
      inputSchema: {
        type: "object",
        properties: {
          assertion: { type: "string", description: "The ID-JAG assertion (compact JWS)." },
          resource: {
            type: "string",
            enum: ["ppad", "appb"],
            default: "ppad",
            description: "Which resource app this read targets. Audience is validated against it.",
          },
          fileId: { type: "string", description: "The protected file id to read." },
        },
        required: ["assertion", "fileId"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    // Unknown tool — return a structured rejection rather than throwing.
    const result: ReadResult = {
      outcome: "rejected",
      code: "malformed_assertion",
      file_id: "",
      message: `Unknown tool '${req.params.name}'.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }

  const args = (req.params.arguments ?? {}) as { assertion?: string; resource?: string; fileId?: string };
  const result = await readProtectedFile(
    { assertion: args.assertion ?? "", resource: args.resource, fileId: args.fileId ?? "" },
    config,
  );

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Note: stdout is reserved for the MCP protocol; log to stderr only.
console.error("ppad-xaa-mcp-tool ready (stdio). Tool:", TOOL_NAME);
