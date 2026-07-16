# Claude-Code-CLI Brain (Neumann-Probe-LLM harness)

The api-server's game "brain" no longer uses OpenAI. `POST /api/vng/command` now
spawns the local **Claude Code CLI in headless mode** using your **Claude
subscription** (OAuth login — no API key, no API billing). The CLI reaches the
game only through a custom **stdio MCP server** that exposes just the tools
classified `SAFE` in `src/routes/vng/tool-policy.ts`.

## Endpoints (all under `/api/vng`)

| Method + path                              | Purpose                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET  /state`                              | Live probe telemetry. `?probeId=N` targets another owned probe.                                                                                                                                                                                                      |
| `POST /command`                            | Natural-language order. Spawns headless Claude, streams SSE. Body `{ command, sessionId?, probeId? }`. A non-integer `probeId` → `400`.                                                                                                                              |
| `POST /tool`                               | **Direct tool call, no LLM.** Body `{ tool, args?, confirm? }`. `200 {ok,result}`; irreversible tool without `confirm:true` → `409 {requiresConfirmation:true,tool}`; error → `500 {error}`. Always targets the main probe — it has no `probeId`, unlike `/command`. |
| `GET  /scheduled`, `DELETE /scheduled/:id` | Scheduled-action management (unchanged).                                                                                                                                                                                                                             |

SSE event shapes emitted by `/command` (unchanged, frontend-compatible):
`{type:"status",message}`, `{type:"message",content}`,
`{type:"action",tool,params,id}`, `{type:"result",tool,id,success,data|error}`,
`{type:"error",message}`, `{type:"done"}`.

## Tool gating

`runTool` (`src/routes/vng/run-tool.ts`) is the single choke point, and
`src/routes/vng/tool-policy.ts` is the **source of truth** for the
classification — read it rather than any count restated here (counts rot; that
is why the earlier "12 safe / 6 irreversible" lists here were both wrong). Its
boot-time `assertPolicyCoversTools()` turns any drift between the policy and
`tools.ts` into a loud startup failure.

Three sets keyed by tool name:

- **`SAFE`** — reversible or read-only. The **only** tools registered on the MCP
  server, so the only ones the headless brain can call; also callable via
  `POST /tool` without `confirm`.
- **`IRREVERSIBLE`** — permanent game-state changes (jump, jettison, detach/drop
  container, salvage, recall, cargo drops — plus `assemble_probe`, `send_message`,
  `transfer_deuterium`; see `tool-policy.ts` for the exact membership). Never on
  the MCP server; through `runTool` they return
  `{requiresConfirmation:true}` **without executing** unless `confirm:true`.
- **`UNREVIEWED`** — reviewed but deliberately held out of the brain's reach
  (`improve_probe`, `turn_on_relay`, `install_waypoint_bookmark`); gated exactly
  like `IRREVERSIBLE`. A tool that lands here by default (e.g. an upstream
  addition) is undecided until someone classifies it.

Scheduling is gated on the **scheduled payload**, not on `schedule_action`
itself, so queuing a jump needs the same go-ahead as jumping.

## Environment

Loaded from the monorepo-root `.env` automatically (via `src/load-env.ts`,
Node's native `process.loadEnvFile`, no dotenv dependency).

- `VNG_API_KEY` (required) — game API auth; forwarded to the MCP subprocess.
- `PORT` (required) — server bind port.
- `CLAUDE_BRAIN_MODEL` (optional, default `sonnet`) — model passed to `--model`.
- `CLAUDE_BIN` (optional) — path to the `claude` executable. Auto-detected at
  `~/.local/bin/claude(.exe)`, else falls back to `claude` on PATH.
- `VNG_DATA_DIR` (set internally) — passed to the MCP subprocess so its
  bookkeeping writes to the same `data/` dir as the server. Takes precedence
  over `DATA_DIR`. `file-store.ts` exports the resolved dir; import it rather
  than re-deriving one, or the server and its subprocess can split bookkeeping.
- `DATA_DIR` (optional) — overrides the data dir outright. Set by the
  Electron app, whose packaged cwd is unpredictable, to the user-data folder.
- `VNG_PROBE_ID` (set internally) — passed to the MCP subprocess to scope every
  tool call to the probe the operator picked in the UI. Unset = main probe. It
  travels by env, not as a tool argument, so the brain can neither see nor
  override it, and the config is rewritten per request.

**Subscription auth:** the spawned CLI inherits the server env with
`ANTHROPIC_API_KEY` **deleted**, forcing OAuth (subscription) instead of API
billing. Make sure you are logged in: run `claude` once interactively and
complete the login.

## Build & run

```bash
# install deps (once) — MCP SDK already added
pnpm install

# build both the server and the MCP server (dist/index.mjs + dist/neumann-mcp.mjs)
pnpm --filter @workspace/api-server run build

# run (reads root .env for PORT + VNG_API_KEY). Start from the api-server dir so
# its data/ dir matches the MCP subprocess's VNG_DATA_DIR.
cd artifacts/api-server && node --enable-source-maps ./dist/index.mjs
# or: pnpm --filter @workspace/api-server run dev   (build + start)
```

The MCP server bundle is produced at
`artifacts/api-server/dist/neumann-mcp.mjs`. `/command` writes a temp
`--mcp-config` JSON that launches it via `node <that path>`.

## Frontend (Probe Commander) — Windows run

The React UI at `artifacts/probe-commander` is where you drive the probe. It
requires two env vars and reaches the api-server through a Vite `/api` proxy.

```powershell
# from the repo root, in PowerShell:
$env:PORT='24340'
pnpm --filter @workspace/probe-commander run dev
# -> http://localhost:24340/   (needs the api-server already running on :8080)
```

- `PORT` = frontend port (required — `vite.config.ts` throws without it). Keep it
  different from the api-server's 8080.
- `BASE_PATH` = Vite base. **No longer needs setting**: it defaults to `/`
  (upstream added the default for local/Electron builds; only Replit sets it).
  This retires the old git-bash trap — passing `BASE_PATH=/` through git-bash got
  MSYS-mangled into a Windows path, so the fix now is simply not to pass it.
  The UI derives its API base from it, and a dev proxy in `vite.config.ts`
  forwards `/api` → `http://localhost:8080` (override with `API_TARGET`). SSE
  streaming for `/command` passes through.

**Windows install note:** see the "Windows / pnpm" section of `CLAUDE.md`. Short
version: the cause was upstream's `pnpm-workspace.yaml` `overrides` excluding
win32 binaries (now fixed upstream), the explicit `*-win32-x64-msvc` devDeps in
`probe-commander/package.json` are what carried us, and `.npmrc`'s
`supportedArchitectures` block is dead config that pnpm 10 never reads.

## Multi-turn note

`/command` accepts an optional `sessionId`; when supplied it is passed to the CLI
as `--session-id` for multi-turn continuity. The current frontend does not send
one, so each command runs as a fresh session. To enable multi-turn memory, have
the client generate and persist one UUID per conversation and include it in the
POST body.
