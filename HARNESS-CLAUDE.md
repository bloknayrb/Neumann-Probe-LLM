# Claude-Code-CLI Brain (Neumann-Probe-LLM harness)

The api-server's game "brain" no longer uses OpenAI. `POST /api/vng/command` now
spawns the local **Claude Code CLI in headless mode** using your **Claude
subscription** (OAuth login — no API key, no API billing). The CLI reaches the
game only through a custom **stdio MCP server** that exposes the 12 safe tools.

## Endpoints (all under `/api/vng`)

| Method + path            | Purpose |
|--------------------------|---------|
| `GET  /state`            | Live probe telemetry (unchanged). |
| `POST /command`          | Natural-language order. Spawns headless Claude, streams SSE. Body `{ command, sessionId? }`. |
| `POST /tool`             | **Direct tool call, no LLM.** Body `{ tool, args?, confirm? }`. `200 {ok,result}`; irreversible tool without `confirm:true` → `409 {requiresConfirmation:true,tool}`; error → `500 {error}`. |
| `GET  /scheduled`, `DELETE /scheduled/:id` | Scheduled-action management (unchanged). |

SSE event shapes emitted by `/command` (unchanged, frontend-compatible):
`{type:"status",message}`, `{type:"message",content}`,
`{type:"action",tool,params,id}`, `{type:"result",tool,id,success,data|error}`,
`{type:"error",message}`, `{type:"done"}`.

## Tool gating

`runTool` (`src/routes/vng/run-tool.ts`) is the single choke point. The 6
**irreversible** tools — `move_probe`, `jettison_item`, `detach_container`,
`drop_container_on_asteroid`, `salvage_object`, `recall_manny` — require
`confirm:true` or they return `{requiresConfirmation:true}` **without executing**.
They are **not registered on the MCP server at all**, so the headless brain
physically cannot call them. It only sees the 12 safe tools:
`get_game_state, scan_sector, craft_item, atomic_printer_craft, mine_resources,
inspect_asteroid, repair_manny, rename_manny, deploy_manny, recover_container,
schedule_action, cancel_scheduled_action`.

## Environment

Loaded from the monorepo-root `.env` automatically (via `src/load-env.ts`,
Node's native `process.loadEnvFile`, no dotenv dependency).

- `VNG_API_KEY`  (required) — game API auth; forwarded to the MCP subprocess.
- `PORT`         (required) — server bind port.
- `CLAUDE_BRAIN_MODEL` (optional, default `sonnet`) — model passed to `--model`.
- `CLAUDE_BIN`   (optional) — path to the `claude` executable. Auto-detected at
  `~/.local/bin/claude(.exe)`, else falls back to `claude` on PATH.
- `VNG_DATA_DIR` (set internally) — passed to the MCP subprocess so its
  bookkeeping writes to the same `data/` dir as the server.

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
# from the repo root, in PowerShell (NOT git-bash — it mangles BASE_PATH=/):
$env:PORT='24340'; $env:BASE_PATH='/'
pnpm --filter @workspace/probe-commander run dev
# -> http://localhost:24340/   (needs the api-server already running on :8080)
```

- `PORT` = frontend port (keep it different from the api-server's 8080).
- `BASE_PATH` = Vite base; `/` for local. The UI derives its API base from this,
  and a dev proxy in `vite.config.ts` forwards `/api` → `http://localhost:8080`
  (override target with `API_TARGET`). SSE streaming for `/command` passes through.

**Windows install note:** the committed `pnpm-lock.yaml` was generated on Linux,
so pnpm skipped Windows-native binaries. Fixed by adding to `.npmrc`
(`supportedArchitectures.os[]=win32`, `cpu[]=x64`, `libc[]=none`) and installing
the platform packages: `@rollup/rollup-win32-x64-msvc@4.60.3`,
`lightningcss-win32-x64-msvc@1.32.0`, `@tailwindcss/oxide-win32-x64-msvc@4.3.0`
(+ esbuild's win32 binary via `pnpm install --force`). If a fresh `pnpm install`
regresses this, re-add those.

## Multi-turn note

`/command` accepts an optional `sessionId`; when supplied it is passed to the CLI
as `--session-id` for multi-turn continuity. The current frontend does not send
one, so each command runs as a fresh session. To enable multi-turn memory, have
the client generate and persist one UUID per conversation and include it in the
POST body.
