/**
 * Neumann-Probe stdio MCP server.
 *
 * Exposes ONLY the safe (reversible / non-destructive) game tools to the
 * headless Claude Code brain. The 6 irreversible tools are omitted entirely so
 * the brain cannot invoke them directly.
 *
 * Reads VNG_API_KEY (and optional VNG_DATA_DIR, VNG_PROBE_ID) from its own
 * process env — the Claude CLI injects these via the --mcp-config file.
 *
 * VNG_PROBE_ID scopes every tool call to the probe the operator selected in the
 * UI. It arrives via env rather than a tool argument on purpose: the brain
 * cannot see or override it, so it cannot address a probe the operator didn't
 * pick. Unset means the operator's main probe.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "../routes/vng/tools.js";
import { runTool } from "../routes/vng/run-tool.js";
import { parseProbeId } from "../routes/vng/client.js";
import {
  assertPolicyCoversTools,
  isExposedToBrain,
} from "../routes/vng/tool-policy.js";

// Refuse to start on policy/tools drift rather than silently exposing the wrong
// set. This is the load-bearing check: a shrunken toolset is invisible at
// runtime — the brain just stops using a capability and never says why.
assertPolicyCoversTools();

const exposed = TOOLS.filter((t) => isExposedToBrain(t.function.name));

// Safe to resolve once: the CLI spawns a fresh subprocess per order (see above),
// so this never has to change mid-process. A malformed value throws here and
// kills the server rather than defaulting to the main probe.
const PROBE_ID = parseProbeId(process.env.VNG_PROBE_ID);

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

  if (!isExposedToBrain(name)) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown or disallowed tool: ${name}` }],
    };
  }

  try {
    const result = await runTool(name, args, { probeId: PROBE_ID });

    // runTool REFUSES by returning, not by throwing. Returned as a plain content
    // block this reads as success: the SSE mapper only sets success:false when
    // is_error is set, and the console renders "✓ ... OK" — so a refused order
    // would show the operator a green checkmark for something that never
    // happened. The brain cannot set `confirm`, so this fires for real: it's the
    // whole "schedule a jump" path.
    if (
      result &&
      typeof result === "object" &&
      (result as { requiresConfirmation?: unknown }).requiresConfirmation ===
        true
    ) {
      const { tool, gatedOn } = result as { tool: string; gatedOn: string };
      const why =
        tool === gatedOn
          ? "is irreversible"
          : `schedules "${gatedOn}", which is irreversible`;
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `NOT EXECUTED — nothing was scheduled or changed. "${tool}" ${why}, and irreversible actions need the operator's explicit go-ahead through the console. Tell the operator plainly that this did not happen and why.`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: err?.message ?? String(err) }),
        },
      ],
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
