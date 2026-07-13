/**
 * Neumann-Probe stdio MCP server.
 *
 * Exposes ONLY the 12 safe (reversible / non-destructive) game tools to the
 * headless Claude Code brain. The 6 irreversible tools are omitted entirely so
 * the brain physically cannot invoke them. Each tool is derived from the
 * OpenAI-style `TOOLS` definitions and dispatched through `runTool`, which also
 * performs post-tool bookkeeping.
 *
 * Reads VNG_API_KEY (and optional VNG_DATA_DIR) from its own process env — the
 * Claude CLI injects these via the --mcp-config file.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "../routes/vng/tools.js";
import { runTool } from "../routes/vng/run-tool.js";

const SAFE_TOOLS = new Set<string>([
  "get_game_state",
  "scan_sector",
  "craft_item",
  "atomic_printer_craft",
  "mine_resources",
  "inspect_asteroid",
  "repair_manny",
  "rename_manny",
  "deploy_manny",
  "recover_container",
  "schedule_action",
  "cancel_scheduled_action",
]);

const exposed = TOOLS.filter((t) => SAFE_TOOLS.has(t.function.name));

const server = new Server(
  { name: "neumann", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: exposed.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: (t.function.parameters ?? {
      type: "object",
      properties: {},
    }) as any,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (!SAFE_TOOLS.has(name)) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown or disallowed tool: ${name}` }],
    };
  }

  try {
    const result = await runTool(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: err?.message ?? String(err) }) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP JSON-RPC channel.
  console.error(`[neumann-mcp] ready — ${exposed.length} tools exposed`);
}

main().catch((err) => {
  console.error("[neumann-mcp] fatal:", err);
  process.exit(1);
});
