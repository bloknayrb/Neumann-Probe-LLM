/**
 * Safety classification for every game tool — the single source of truth for
 * "what may the brain call?" and "what needs Bryan's go-ahead?".
 *
 * WHY THIS FILE EXISTS, AND WHY IT ISN'T A FLAG ON `defineTool`:
 * `tools.ts` is upstream's file and gets regenerated wholesale (one commit
 * rewrote it +392/-761). Safety metadata colocated with each tool definition
 * would be silently erased by a routine merge — and since an unclassified tool
 * fails closed, erasure would quietly strip the brain of every capability while
 * looking like an ordinary sync. This file is fork-owned: a merge cannot touch
 * it, and `assertPolicyCoversTools()` turns any upstream tool churn into a loud
 * boot failure instead of a silent hole.
 *
 * Keyed by tool NAME rather than by reference for the same reason: names are the
 * only stable handle across a wholesale regeneration.
 */
import { TOOLS } from "./tools.js";

/**
 * Reversible or read-only. Safe for the headless brain to call unattended, and
 * callable via POST /api/vng/tool without a confirmation.
 */
export const SAFE = new Set<string>([
  "get_game_state",
  "scan_sector",
  "craft_item",
  "atomic_printer_craft",
  "mine_resources",
  "inspect_sector_object",
  "repair_manny",
  "rename_manny",
  "deploy_manny",
  "recover_container",
  "schedule_action",
  "cancel_scheduled_action",
]);

/**
 * Permanently changes game state. Never exposed to the brain, and requires an
 * explicit `confirm: true` (i.e. Bryan's go-ahead) through `runTool`.
 */
export const IRREVERSIBLE = new Set<string>([
  "move_probe",
  "jettison_item",
  "detach_container",
  "drop_container_on_asteroid",
  "drop_container_on_planet",
  "salvage_object",
  "recall_manny",
  "drop_manny_cargo",
]);

/**
 * Tools nobody has ruled on yet. They behave exactly like IRREVERSIBLE (gated,
 * never exposed to the brain) — the separate set records that this is an absence
 * of a decision, not a decision. Move entries into SAFE or IRREVERSIBLE as they
 * get reviewed; the goal is for this set to reach empty.
 */
export const UNREVIEWED = new Set<string>([
  "assemble_probe",
  "improve_probe",
  "install_waypoint_bookmark",
  "refill_deuterium_tank",
  "send_message",
  "transfer_deuterium",
  "turn_on_relay",
]);

/** Tools the MCP server exposes to the brain. Everything else is unreachable. */
export function isExposedToBrain(name: string): boolean {
  return SAFE.has(name);
}

/** Tools that `runTool` refuses to run without `confirm: true`. */
export function requiresConfirmation(name: string): boolean {
  return !SAFE.has(name);
}

/**
 * Fail fast if the policy and the tool list have drifted apart — the failure
 * this whole module exists to prevent. An upstream sync that adds a tool, or
 * renames one out from under us, stops the server here with the offending names
 * instead of silently shrinking what the brain can do.
 *
 * That is not hypothetical: upstream renamed `inspect_asteroid` to
 * `inspect_sector_object`, our hand-maintained list kept the old string, and the
 * brain lost its inspect capability for months with nothing to show for it.
 */
export function assertPolicyCoversTools(): void {
  const defined = new Set(TOOLS.map((t) => t.function.name));
  const classified = [...SAFE, ...IRREVERSIBLE, ...UNREVIEWED];

  const unclassified = [...defined].filter((n) => !classified.includes(n));
  const orphaned = classified.filter((n) => !defined.has(n));
  const problems: string[] = [];
  if (unclassified.length)
    problems.push(`tools with no policy entry: ${unclassified.join(", ")}`);
  if (orphaned.length)
    problems.push(`policy entries with no such tool: ${orphaned.join(", ")}`);
  if (problems.length)
    throw new Error(
      `tool-policy is out of sync with tools.ts — ${problems.join("; ")}`,
    );
}
