import { logger } from "../../lib/logger.js";
import * as client from "./client.js";
import { runTool } from "./run-tool.js";
import {
  getPendingActions,
  resolvePendingAction,
  type PendingAction,
  type PendingActionPayload,
} from "./file-store.js";

const POLL_INTERVAL_MS = 30_000;
let started = false;

async function checkCondition(
  action: PendingAction,
  mannies: any[],
  probe: any,
): Promise<boolean> {
  const cond = action.condition;
  if (cond.type === "manny_idle") {
    const m = mannies.find((m: any) => m.id === cond.mannyId);
    if (!m || m.currentTask) return false;

    // Optional inventory dependency guard: all required item types must exist
    if (cond.requireItems && cond.requireItems.length > 0) {
      const inventoryItems: any[] = probe?.inventory?.items ?? [];
      const inventoryContainers: any[] = probe?.inventory?.containers ?? [];
      // item types come from inv.items; container items are checked by label/name too
      const itemTypes = new Set([
        ...inventoryItems.map((i: any) => i.type),
        ...inventoryContainers.map((c: any) => c.kind),
      ]);
      const allPresent = cond.requireItems.every((req) => itemTypes.has(req));
      if (!allPresent) {
        logger.info(
          {
            actionId: action.id,
            requireItems: cond.requireItems,
            found: [...itemTypes],
          },
          "poller: manny idle but required items not yet in inventory — waiting",
        );
        return false;
      }
    }

    return true;
  }
  if (cond.type === "probe_idle") {
    return probe?.movement?.status !== "moving";
  }
  return false;
}

/**
 * Translate a stored action into the (tool, args) pair `runTool` speaks. The
 * stored payload is camelCase; the tool schemas are snake_case.
 */
export function toToolCall(a: PendingActionPayload): {
  name: string;
  args: Record<string, unknown>;
} {
  switch (a.type) {
    case "move_probe":
      return { name: "move_probe", args: { x: a.x, y: a.y, z: a.z } };
    case "craft_item":
      return {
        name: "craft_item",
        args: { manny_id: a.mannyId, recipe: a.recipe },
      };
    case "mine_resources":
      return {
        name: "mine_resources",
        args: {
          manny_id: a.mannyId,
          object_id: a.objectId,
          resources: a.resources,
          target_amount: a.targetAmount,
          target_container_id: a.targetContainerId,
        },
      };
    case "detach_container":
      // A stored detach carries no mode, so it is always a plain drift. Sent
      // explicitly rather than leaning on the handler's default: the schema
      // marks mode required, and the default is two layers away in client.ts.
      return {
        name: "detach_container",
        args: {
          manny_id: a.mannyId,
          container_id: a.containerId,
          mode: "drifting",
        },
      };
    case "recover_container":
      return {
        name: "recover_container",
        args: { manny_id: a.mannyId, object_id: a.objectId },
      };
    default:
      throw new Error(`Unknown action type`);
  }
}

/**
 * Fire a due action through the same choke point as every other game action, so
 * it gets `afterTool` bookkeeping — a scheduled detach used to leave no trace in
 * detached-containers.json, orphaning the container the moment it drifted.
 *
 * `confirm: true` is honest rather than a bypass: consent happened at scheduling
 * time. `runTool` inspects a schedule_action payload and refuses to create the
 * row at all unless the operator confirmed the action inside it, so a pending
 * row for an irreversible action can only exist if it was already approved. The
 * poller is carrying out a decision, not making one.
 */
async function executeAction(action: PendingAction): Promise<void> {
  const { name, args } = toToolCall(action.action);
  const result = await runTool(name, args, { confirm: true });

  // runTool REFUSES by returning, not by throwing. Our caller reads a clean
  // return as success and stamps the row "triggered" — so a refusal that slips
  // through here would be logged as "action triggered successfully" while
  // nothing happened. `confirm: true` means this is currently unreachable;
  // it's here so that if that ever stops being true, it fails loudly.
  if (
    result &&
    typeof result === "object" &&
    (result as { requiresConfirmation?: unknown }).requiresConfirmation === true
  ) {
    throw new Error(
      `runTool refused ${name} despite confirm:true — scheduled action not executed`,
    );
  }
}

/** Return the manny ID that an action will occupy, if any. */
function actionMannyId(action: PendingAction): string | null {
  const a = action.action;
  // Called before the try/catch below, so a row whose action is missing would
  // throw out of poll() entirely — and since the row stays pending, every later
  // tick would die on it too, stopping ALL scheduled work permanently. Tolerate
  // it here; toToolCall rejects it inside the guarded block, where it becomes a
  // "failed" row instead of a wedged poller.
  if (!a || typeof a !== "object") return null;
  if (
    a.type === "craft_item" ||
    a.type === "mine_resources" ||
    a.type === "detach_container" ||
    a.type === "recover_container"
  ) {
    return a.mannyId;
  }
  return null;
}

async function poll(): Promise<void> {
  const pending = await getPendingActions();
  if (pending.length === 0) return;

  let probeResp: any = null;
  let manniesResp: any = null;
  try {
    [probeResp, manniesResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
    ]);
  } catch (err) {
    logger.warn({ err }, "poller: failed to fetch probe state");
    return;
  }

  const mannies: any[] = manniesResp?.mannies ?? [];
  const probe = probeResp?.probe ?? null;

  // Track mannies and singleton resources claimed this cycle so we only fire
  // one action per manny (and one probe-move) per poll tick.
  const claimedMannies = new Set<string>();
  let probeMoveClaimed = false;

  for (const action of pending) {
    // Check if the resource this action needs is already claimed this cycle
    const mannyId = actionMannyId(action);
    if (mannyId && claimedMannies.has(mannyId)) {
      logger.info(
        { actionId: action.id, mannyId },
        "poller: manny already claimed this cycle — deferring to next tick",
      );
      continue;
    }
    if (action.action.type === "move_probe" && probeMoveClaimed) {
      logger.info(
        { actionId: action.id },
        "poller: probe move already claimed this cycle — deferring",
      );
      continue;
    }

    let conditionMet = false;
    try {
      conditionMet = await checkCondition(action, mannies, probe);
    } catch (err) {
      logger.warn(
        { err, actionId: action.id },
        "poller: condition check error",
      );
      continue;
    }

    if (!conditionMet) continue;

    logger.info(
      { actionId: action.id, description: action.description },
      "poller: condition met — executing action",
    );

    try {
      await executeAction(action);
      await resolvePendingAction(action.id, { status: "triggered" });
      logger.info(
        { actionId: action.id },
        "poller: action triggered successfully",
      );

      // Mark the resource as claimed so subsequent actions skip this cycle
      if (mannyId) claimedMannies.add(mannyId);
      if (action.action.type === "move_probe") probeMoveClaimed = true;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      logger.error(
        { actionId: action.id, err: msg },
        "poller: action execution failed",
      );
      await resolvePendingAction(action.id, { status: "failed", error: msg });
    }
  }
}

export function startPoller(): void {
  if (started) return;
  started = true;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "poller: started");
  // Reentrancy guard: a tick that runs long (executeAction is a real game call)
  // must not overlap the next one, or both could read the same pending row and
  // fire it twice. A skipped tick just retries in POLL_INTERVAL_MS.
  let ticking = false;
  setInterval(() => {
    if (ticking) {
      logger.info("poller: previous tick still running — skipping this one");
      return;
    }
    ticking = true;
    poll()
      .catch((err) => logger.error({ err }, "poller: unexpected error"))
      .finally(() => {
        ticking = false;
      });
  }, POLL_INTERVAL_MS);
}
