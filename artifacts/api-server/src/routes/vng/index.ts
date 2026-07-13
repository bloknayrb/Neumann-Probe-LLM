import { Router } from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp, constants as fsc } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as client from "./client.js";
import { runTool } from "./run-tool.js";
import { mapSectorObjects } from "./sector-map.js";
import {
  cancelPendingAction,
  recordSector,
  getPendingActions,
} from "./file-store.js";

const router = Router();

// Resolve paths relative to this bundled module (dist/index.mjs).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(HERE, "neumann-mcp.mjs");
const DATA_DIR = path.join(HERE, "..", "data");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// The 12 safe tools the headless brain is allowed to call (MCP-prefixed).
const ALLOWED_MCP_TOOLS = [
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
]
  .map((t) => `mcp__neumann__${t}`)
  .join(" ");

function resolveClaudeBin(): { bin: string; shell: boolean } {
  if (process.env.CLAUDE_BIN) return { bin: process.env.CLAUDE_BIN, shell: false };
  const guess = path.join(
    os.homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  if (existsSync(guess)) return { bin: guess, shell: false };
  // Fallback: rely on PATH resolution (shell needed for .cmd shims on Windows).
  return { bin: "claude", shell: process.platform === "win32" };
}

function sse(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.get("/scheduled", async (_req, res) => {
  try {
    const actions = await getPendingActions();
    res.json({ actions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/scheduled/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await cancelPendingAction(id);
    if (ok) res.json({ ok: true });
    else res.status(404).json({ error: `No pending action with id ${id}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/state", async (_req, res) => {
  try {
    const [probeResp, manniesResp, sectorResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
      client.getSector().catch(() => null), // unavailable during high-speed transit
    ]);

    const probe = probeResp.probe;
    const inv = probe.inventory ?? {};
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };
    const sectorObjects: any[] = sectorResp?.sector?.objects ?? [];

    recordSector(sector.x, sector.y, sector.z, sectorObjects).catch(() => {});

    const mannies = (manniesResp.mannies ?? []).map((m: any) => {
      const task = m.task && typeof m.task === "object" && !Array.isArray(m.task) ? m.task : null;
      return {
        id: m.id,
        name: m.name,
        currentTask: m.currentTask,
        taskProgressPercent: m.taskProgressPercent,
        taskEstimatedEndTime: m.taskEstimatedEndTime ?? null,
        location: m.location ?? null,
        // Extra fields for the SYSTEM map's manny-movement layer. `phase`
        // (outbound / mining / inbound / depositing) is the truthful travel
        // direction; `taskObjectId` links to the body being serviced;
        // `taskVisibility` gates plotting to the current system only.
        taskVisibility: m.taskVisibility ?? null,
        taskObjectId: task?.objectId ?? null,
        taskPhase: task?.phase ?? null,
        taskTripIndex: task?.tripIndex ?? null,
        miningTravelSeconds: task?.miningTravelSeconds ?? null,
        taskTargetAmount: task?.targetAmount ?? null,
        taskDepositedAmount: task?.depositedAmount ?? null,
      };
    });

    const activeMannyIds = new Set((manniesResp.mannies ?? []).map((m: any) => m.id));
    const stowedMannies = ((probeResp.probe?.inventory?.items ?? []) as any[])
      .filter((i: any) => i.type === "manny" && !activeMannyIds.has(i.id))
      .map((i: any) => ({ itemId: i.id, name: i.label ?? i.name ?? "Unnamed Manny" }));

    // Enriched superset of the old flattened shape (adds bodies/habitability/
    // per-type detail + dangerLevel) so the SYSTEM map has what it needs while
    // existing consumers (TelemetryPanel) keep working unchanged.
    const sectorObjectsMapped = mapSectorObjects(sectorObjects);
    // `probes` is a sibling of `objects`, present only when another probe
    // shares the sector; absent (not empty) otherwise.
    const otherProbes = sectorResp?.sector?.probes ?? [];

    res.json({
      probe: {
        id: probe.id,
        name: probe.name,
        status: probe.status,
        fuelDeuterium: probe.fuel?.deuterium ?? 0,
        integrityPercent: probe.systems?.integrityPercent ?? 0,
        sector,
        movement: probe.movement ?? null,
      },
      inventory: {
        capacity: inv.capacity ?? 0,
        usedCapacity: inv.usedCapacity ?? 0,
        freeCapacity: inv.freeCapacity ?? 0,
      },
      mannies,
      stowedMannies,
      sectorObjects: sectorObjectsMapped,
      otherProbes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Direct tool endpoint for an external agent — no LLM loop.
 * Body: { tool: string, args?: object, confirm?: boolean }
 * Irreversible tools without confirm:true return 409 requiresConfirmation.
 */
router.post("/tool", async (req, res) => {
  const { tool, args, confirm } = req.body as {
    tool?: string;
    args?: Record<string, unknown>;
    confirm?: boolean;
  };

  if (!tool?.trim()) {
    res.status(400).json({ error: "tool is required" });
    return;
  }

  try {
    const result = await runTool(tool, args ?? {}, { confirm });
    if (
      result &&
      typeof result === "object" &&
      (result as any).requiresConfirmation === true
    ) {
      res.status(409).json(result);
      return;
    }
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const CLAUDE_MODEL = process.env.CLAUDE_BRAIN_MODEL || "sonnet";

function buildPrompt(command: string): string {
  return `You are GUPPI, the onboard AI assistant of a Von Neumann Probe. You carry out the operator's orders by calling the provided game tools (exposed via the "neumann" MCP server).

OPERATING RULES:
- ALWAYS call get_game_state FIRST to load the current probe status, mannies (with their exact string IDs), sector objects, inventory, and crafting recipes. Never invent IDs — only use IDs returned by the tools.
- Use exact Manny IDs (long strings like "mny_e84fa37181de693e8e831147").
- Mining, crafting, and salvage are long-running: once started the Manny is busy for real game time. Tell the operator the task was QUEUED.
- For "when X finishes, do Y" style orders, use schedule_action and report the scheduled action ID.
- You have access ONLY to safe, reversible tools. Destructive actions (moving the probe, jettisoning, detaching/dropping containers, salvage, recall) are intentionally unavailable — if the operator asks for one, explain it must be confirmed through the operator console.
- Be concise and precise. End with a short summary of what you did or found.

OPERATOR ORDER:
${command}`;
}

/**
 * Map one Claude stream-json event onto the harness's existing SSE event shape.
 * We drive off the complete assistant/user/result messages (not per-token
 * partials) so the frontend renders one clean block per message / tool call.
 */
function stripPrefix(toolName: string): string {
  return toolName.replace(/^mcp__neumann__/, "");
}

router.post("/command", async (req, res) => {
  const { command, sessionId: bodySessionId } = req.body as {
    command: string;
    sessionId?: string;
  };

  if (!command?.trim()) {
    res.status(400).json({ error: "command is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sessionId = bodySessionId?.trim() || randomUUID();
  let mcpConfigPath: string | null = null;
  // Map tool_use id -> display tool name so we can label tool_result events.
  const toolNamesById = new Map<string, string>();
  let finished = false;

  const finish = (child?: import("node:child_process").ChildProcess) => {
    if (finished) return;
    finished = true;
    sse(res, { type: "done" });
    res.end();
    if (mcpConfigPath) fsp.unlink(mcpConfigPath).catch(() => {});
    if (child && !child.killed) child.kill();
  };

  try {
    sse(res, { type: "status", message: "Spawning Claude brain…" });

    // Write the MCP config to a temp file (inline JSON breaks Windows quoting).
    const apiKey = process.env.VNG_API_KEY ?? "";
    mcpConfigPath = path.join(os.tmpdir(), `neumann-mcp-${randomUUID()}.json`);
    const mcpConfig = {
      mcpServers: {
        neumann: {
          command: process.execPath,
          args: [MCP_SERVER_PATH],
          env: {
            VNG_API_KEY: apiKey,
            VNG_DATA_DIR: DATA_DIR,
          },
        },
      },
    };
    // Atomic owner-only creation: the config embeds VNG_API_KEY in plaintext, so
    // never leave a world-readable window. O_EXCL guarantees we create a fresh
    // file; 0o600 restricts to owner (no-op on Windows, correct on POSIX).
    {
      const fh = await fsp.open(
        mcpConfigPath,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL,
        0o600,
      );
      try {
        await fh.writeFile(JSON.stringify(mcpConfig), "utf8");
      } finally {
        await fh.close();
      }
    }

    // Subscription auth: delete ANTHROPIC_API_KEY so the CLI uses OAuth login.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;

    const prompt = buildPrompt(command);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      ALLOWED_MCP_TOOLS,
      "--permission-mode",
      "dontAsk",
      "--session-id",
      sessionId,
      "--model",
      CLAUDE_MODEL,
      prompt,
    ];

    const { bin, shell } = resolveClaudeBin();
    const child = spawn(bin, args, {
      shell,
      env: childEnv,
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Safety valve: don't stream forever.
    const timeout = setTimeout(() => {
      sse(res, { type: "error", message: "Brain timed out after 180s." });
      finish(child);
    }, 180_000);

    sse(res, { type: "status", message: "Brain thinking…" });

    const rl = readline.createInterface({ input: child.stdout! });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON noise
      }

      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            sse(res, { type: "message", content: block.text });
          } else if (block.type === "tool_use") {
            const display = stripPrefix(block.name);
            toolNamesById.set(block.id, display);
            sse(res, {
              type: "action",
              tool: display,
              params: block.input ?? {},
              id: block.id,
            });
          }
        }
      } else if (evt.type === "user" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "tool_result") {
            const id = block.tool_use_id;
            const toolName = toolNamesById.get(id) ?? "tool";
            let data: unknown = block.content;
            // MCP tool results arrive as [{type:"text", text:"<json>"}].
            if (Array.isArray(block.content)) {
              const textPart = block.content.find((c: any) => c.type === "text");
              if (textPart?.text) {
                try {
                  data = JSON.parse(textPart.text);
                } catch {
                  data = textPart.text;
                }
              }
            }
            if (block.is_error) {
              sse(res, {
                type: "result",
                tool: toolName,
                id,
                success: false,
                error: typeof data === "string" ? data : JSON.stringify(data),
              });
            } else {
              sse(res, { type: "result", tool: toolName, id, success: true, data });
            }
          }
        }
      } else if (evt.type === "result") {
        // Final result envelope. If it carries a text summary and no assistant
        // text was streamed, surface it.
        if (evt.is_error && evt.result) {
          sse(res, { type: "error", message: String(evt.result) });
        }
      }
    });

    let stderrBuf = "";
    child.stderr!.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      sse(res, { type: "error", message: `Failed to spawn brain: ${err.message}` });
      finish(child);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !finished) {
        sse(res, {
          type: "error",
          message: `Brain exited with code ${code}. ${stderrBuf.slice(0, 500)}`,
        });
      }
      finish(child);
    });

    // Clean up if the client disconnects.
    req.on("close", () => {
      clearTimeout(timeout);
      finish(child);
    });
  } catch (err: any) {
    sse(res, { type: "error", message: err.message });
    finish();
  }
});

export default router;
