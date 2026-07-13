# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the **harness** subsystem of the parent Neumann-probe workspace (see `../CLAUDE.md` for the game/roleplay context and the GUPPI operating rules). Here: how to navigate this monorepo and what not to break.

## Origin & the #1 thing not to undo

Cloned from `SeanPGorman/Neumann-Probe-LLM` (a Replit project — hence `.replit`, a Linux-generated `pnpm-lock.yaml`, and required `PORT`/`BASE_PATH` env vars) and then **deliberately modified so the game "brain" is the local Claude Code CLI on Bryan's subscription, replacing the original OpenAI (`gpt-5.4`) tool-calling loop.**

- **Do NOT reintroduce OpenAI** into `POST /api/vng/command`. The OpenAI loop was intentionally removed; the route now spawns headless `claude`. OpenAI env vars are dead.
- The spawn **deletes `ANTHROPIC_API_KEY` from the child env** to force subscription (OAuth) auth. Never add `--bare` (it disables OAuth). Preserve both.

Full endpoint/env/tool reference: **`HARNESS-CLAUDE.md`** (read it before changing the brain, the tools, or gating).

## What's real vs. dead scaffolding

pnpm workspace globs `artifacts/*`, `lib/*`, `lib/integrations/*`, `scripts`. Almost all of it is unused. The live system is only:

- **`artifacts/api-server/`** — the entire Express backend. Everything that matters is under `src/routes/vng/`.
- **`artifacts/probe-commander/`** — the React 19 + Vite + Tailwind 4 UI ("Probe Commander"). `src/pages/Commander.tsx` is essentially the whole app; it derives its API base from Vite's `base` and calls `/api/vng/*` (dev-proxied to `:8080` — proxy added in `vite.config.ts`).

Ignore for most work: `artifacts/mockup-sandbox` (shadcn playground), `lib/db` (Drizzle schema — **not wired in**; persistence is JSON files under `artifacts/api-server/data/`), `lib/api-*` / `lib/integrations/*` (codegen + OpenAI helpers — unused by the running code). `DATABASE_URL` in old docs is not read.

## Key files in the backend

- `src/routes/vng/tools.ts` — `TOOLS` (18 schemas) + `executeTool(name,args)` → `client.ts` (fetch to neumann-probe.net with `VNG_API_KEY`).
- `src/routes/vng/run-tool.ts` — **the choke point.** `runTool` = irreversible-gate + `executeTool` + `afterTool` (writes `data/*.json` bookkeeping: visited-sectors, detached-containers). Route new game actions through `runTool`, never `executeTool` directly.
- `src/routes/vng/index.ts` — the `/api/vng` routes: `/state`, `/command` (Claude spawn + stream-json→SSE), `/tool` (direct call, 409 on gated), `/scheduled`.
- `src/mcp/neumann-mcp.ts` — stdio MCP server exposing **only the 12 safe tools** (the 6 irreversible ones are omitted so the autonomous brain can't call them). Bundled to `dist/neumann-mcp.mjs`.
- `src/load-env.ts` — loads the monorepo-root `.env` (native `process.loadEnvFile`; no dotenv). Imported first in `src/index.ts`.

## Commands

```bash
pnpm install                                   # deps (see Windows note below)
pnpm --filter @workspace/api-server run build  # esbuild build.mjs -> dist/index.mjs + dist/neumann-mcp.mjs
pnpm run typecheck                             # tsc across libs + artifacts
pnpm exec prettier --write <path>              # formatting (prettier is the only style tool)

# run api-server (:8080) — from the api-server dir so data/ lines up with the MCP subprocess:
cd artifacts/api-server && node --enable-source-maps ./dist/index.mjs
# run frontend (:24340) — PowerShell only (git-bash mangles BASE_PATH=/):
#   $env:PORT='24340'; $env:BASE_PATH='/'; pnpm --filter @workspace/probe-commander run dev
```

No test suite; verify against the live game read-only (`GET /api/vng/state`, or `POST /api/vng/tool {"tool":"get_game_state"}`).

## Windows / pnpm

The lockfile is Linux-generated, so Windows-native binaries get skipped on install. `.npmrc` has `supportedArchitectures.*=win32/x64` and the `@rollup/rollup-win32-x64-msvc`, `lightningcss-win32-x64-msvc`, `@tailwindcss/oxide-win32-x64-msvc` packages were added explicitly. If a fresh `pnpm install` breaks the frontend build with a missing `*.node` / `*-win32-x64-msvc` module, re-add the matching platform package (version must match the base package in the lockfile) and/or `pnpm install --force`.
