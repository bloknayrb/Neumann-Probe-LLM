# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the **harness** subsystem of the parent Neumann-probe workspace (see `../CLAUDE.md` for the game/roleplay context and the GUPPI operating rules). Here: how to navigate this monorepo and what not to break.

## Origin & the #1 thing not to undo

Cloned from `SeanPGorman/Neumann-Probe-LLM` (a Replit project — hence `.replit`, a Linux-generated `pnpm-lock.yaml`, and required `PORT`/`BASE_PATH` env vars) and then **deliberately modified so the game "brain" defaults to the local Claude Code CLI on Bryan's subscription, replacing the original OpenAI (`gpt-5.4`) tool-calling loop.**

- **Claude is the default brain; the OpenAI loop is back as an opt-in _second_ brain** behind a `VNG_BRAIN` switch. `POST /api/vng/command` dispatches on `VNG_BRAIN` (default `claude`) or a per-request `provider` field. This reverses the former "do not reintroduce OpenAI" rule — a considered decision. The OpenAI brain is fenced **identically** to Claude (SAFE tools only, every call through `runTool`), so it can't reach irreversible tools either; it bills **per-token against `OPENAI_API_KEY`**, unlike the subscription-based Claude brain.
- The **Claude** spawn **deletes `ANTHROPIC_API_KEY` from the child env** to force subscription (OAuth) auth. Never add `--bare` (it disables OAuth). Preserve both. (The OpenAI brain spawns nothing, so this concerns only the Claude path.)

Full endpoint/env/tool reference: **`HARNESS-CLAUDE.md`** (read it before changing the brain, the tools, or gating).

## What's real vs. dead scaffolding

pnpm workspace globs `artifacts/*`, `lib/*`, `lib/integrations/*`, `scripts`. Almost all of it is unused. The live system is only:

- **`artifacts/api-server/`** — the entire Express backend. Everything that matters is under `src/routes/vng/`.
- **`artifacts/probe-commander/`** — the React 19 + Vite + Tailwind 4 UI ("Probe Commander"). `src/pages/Commander.tsx` is essentially the whole app; it derives its API base from Vite's `base` and calls `/api/vng/*` (dev-proxied to `:8080` — proxy added in `vite.config.ts`).

Ignore for most work: `artifacts/mockup-sandbox` (shadcn playground), `lib/db` (Drizzle schema — **not wired in**; persistence is JSON files under `artifacts/api-server/data/`), `lib/api-*` / `lib/integrations/*` (codegen + OpenAI helpers — unused by the running code). `DATABASE_URL` in old docs is not read.

## Key files in the backend

- `src/routes/vng/tools.ts` — the `TOOLS` schema set + `executeTool(name,args)` → `client.ts` (fetch to neumann-probe.net with `VNG_API_KEY`).
- `src/routes/vng/tool-policy.ts` — **source of truth** for tool safety (`SAFE` / `IRREVERSIBLE` / `UNREVIEWED` sets); `assertPolicyCoversTools()` fails boot on drift. Consult it rather than any count restated in docs.
- `src/routes/vng/run-tool.ts` — **the choke point.** `runTool` = irreversible-gate + `executeTool` + `afterTool` (writes `data/*.json` bookkeeping: visited-sectors, detached-containers). Route new game actions through `runTool`, never `executeTool` directly.
- `src/routes/vng/index.ts` — the `/api/vng` routes: `/state`, `/command` (Claude spawn + stream-json→SSE), `/tool` (direct call, 409 on gated), `/scheduled`.
- `src/mcp/neumann-mcp.ts` — stdio MCP server exposing **only the `SAFE` tools** (everything gated is omitted so the autonomous brain can't call them). Bundled to `dist/neumann-mcp.mjs`.
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

The root cause was never the Linux-generated lockfile: `pnpm-workspace.yaml` `overrides` explicitly excluded every non-linux-x64 platform binary (`"esbuild>@esbuild/win32-x64": "-"` and friends), because the upstream Replit box only needed linux. Upstream has since un-excluded win32-x64/win32-arm64 and darwin, so a plain install now resolves the right binaries.

What actually keeps Windows working here are the explicit `@rollup/rollup-win32-x64-msvc`, `lightningcss-win32-x64-msvc`, and `@tailwindcss/oxide-win32-x64-msvc` devDeps in `artifacts/probe-commander/package.json` (reached via pnpm's `hoistPattern: ["*"]`). They're redundant with upstream's overrides now but harmless — their pinned versions match upstream's resolved ones. If a fresh install ever breaks the frontend with a missing `*.node` / `*-win32-x64-msvc` module, check those overrides first, then re-add the matching platform package at the lockfile's version.

**`.npmrc` is dead config — do not trust it or extend it.** pnpm 10 reads `supportedArchitectures` only from `pnpm-workspace.yaml`/`package.json`, never `.npmrc` (`pnpm config get supportedArchitectures` → `undefined`). It only looked load-bearing because the default is `["current"]` → win32-x64 on this box anyway. `libc[]=none` isn't even a valid value, and `strict-peer-dependencies=false` / `auto-install-peers=false` are already the defaults (the latter is also set in the workspace file). Removing the file would neither break nor bloat the install.

**Never reintroduce upstream's `allowBuilds:` block** in `pnpm-workspace.yaml` (see the note there). It's inert under pnpm 10 because `onlyBuiltDependencies` short-circuits it, but pnpm 11 drops `onlyBuiltDependencies` and makes `allowBuilds` authoritative — silently stopping esbuild from building, which takes `dist/neumann-mcp.mjs` (and therefore the brain's whole toolset) with it.

Note `electron`'s ~100MB postinstall now runs on **every** install; upstream's `allowBuilds: {electron: false}` never gated it.
