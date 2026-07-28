import * as client from "./client.js";
import { executeTool } from "./tools.js";
import { requiresConfirmation } from "./tool-policy.js";
import {
  addContainer,
  markContainerRecovered,
  recordSector,
  toSectorObjectId,
  updateContainerAnchor,
} from "./file-store.js";

/**
 * Post-tool bookkeeping: persists local tracking state after a successful tool
 * call — detached-container registry, container recovery, visited-sector
 * snapshots.
 *
 * Self-contained: it fetches whatever fresh state it needs rather than relying
 * on a caller-provided snapshot, so it works from both the HTTP endpoint and
 * the MCP subprocess.
 *
 * @param probeId Must match the probe the tool actually ran against. Bookkeeping
 *   reads fresh state to resolve names and coordinates, so a mismatch here files
 *   one probe's containers and sectors under another's.
 */
export async function afterTool(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  probeId: number | null = null,
): Promise<void> {
  if (name === "detach_container") {
    const mannyId = args.manny_id as string;
    const containerId = args.container_id as string;
    const probeClient = client.clientFor(probeId);

    // Resolve display names + current sector from fresh state.
    const [probeResp, manniesResp] = await Promise.all([
      probeClient.getProbe(),
      probeClient.getMannies(),
    ]);
    const probe = probeResp.probe;
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };
    const inv = probe.inventory ?? {};
    const mannyInfo = (manniesResp.mannies ?? []).find(
      (m: any) => m.id === mannyId,
    );
    const itemInfo =
      (inv.containers ?? []).find((c: any) => c.id === containerId) ??
      (inv.items ?? []).find((i: any) => i.id === containerId);
    const sectorObjectId = toSectorObjectId(containerId);

    const record = await addContainer({
      containerId,
      sectorObjectId,
      containerName: itemInfo?.label ?? itemInfo?.name ?? containerId,
      mannyId,
      mannyName: mannyInfo?.name ?? mannyId,
      sectorX: sector.x,
      sectorY: sector.y,
      sectorZ: sector.z,
      status: "floating",
      anchorObjectId: null,
      anchorObjectName: null,
      notes: null,
    });

    // Refresh sector to find the anchor asteroid this container attached to.
    probeClient
      .getSector()
      .then((freshSector) => {
        const freshObj = (freshSector.sector?.objects ?? []).find(
          (o: any) => o.id === sectorObjectId,
        );
        if (freshObj?.targetObjectId) {
          const anchorObj = (freshSector.sector?.objects ?? []).find(
            (o: any) => o.id === freshObj.targetObjectId,
          );
          updateContainerAnchor(
            record.id,
            freshObj.targetObjectId,
            anchorObj?.name ?? null,
          ).catch(() => {});
        }
      })
      .catch(() => {});
    return;
  }

  if (name === "recover_container") {
    await markContainerRecovered(args.object_id as string).catch(() => {});
    return;
  }

  // visited-sectors.json is the MAIN probe's log (see VisitedSector). Recording a
  // secondary probe's observation there would credit its travels to the main
  // probe; per-probe history comes from GET /api/probe/{probeId}/visited-sectors.
  if (probeId != null) return;

  if (name === "scan_sector") {
    const scannedObjects: any[] = (result as any)?.sector?.objects ?? [];
    await recordSector(
      args.x as number,
      args.y as number,
      args.z as number,
      scannedObjects,
    ).catch((e) => console.error("[recordSector afterTool/scan_sector]", e));
    return;
  }

  if (name === "get_game_state") {
    const gs = result as any;
    const gsObjects = gs?.sector?.objects ?? [];
    const gsSector = gs?.probe?.sector ?? { x: 0, y: 0, z: 0 };
    await recordSector(gsSector.x, gsSector.y, gsSector.z, gsObjects).catch(
      (e) => console.error("[recordSector afterTool/get_game_state]", e),
    );
    return;
  }
}

export type RunToolResult =
  | { requiresConfirmation: true; tool: string; gatedOn: string }
  | unknown;

/**
 * Resolve what a call actually needs consent for, or null if it needs none.
 *
 * `schedule_action` is the reason this isn't just a name lookup: the tool itself
 * only writes a row to pending-actions.json, but that row names an action the
 * poller will later execute unattended. Gating the wrapper by its own name would
 * wave through "jump to (9,2,4) once manny-3 goes idle" — the jump still
 * happens, just 30 seconds later and with nobody asked. So a scheduled action is
 * gated on its PAYLOAD, which makes scheduling a jump need exactly the same
 * go-ahead as jumping.
 *
 * Unknown payload types fall through to `requiresConfirmation` and gate, so a
 * tool upstream adds to the enum is refused until it's classified, not run.
 */
function consentRequiredFor(
  name: string,
  args: Record<string, unknown>,
): string | null {
  if (name === "schedule_action") {
    const inner = (args.action as { type?: unknown } | undefined)?.type;
    // Nothing downstream validates this. schedule_action never reaches the game
    // API — it writes the row straight to pending-actions.json, casting through
    // `as any` — and the MCP SDK doesn't check args against inputSchema either.
    // So an unreadable action type is refused here or it is never refused at all.
    if (typeof inner !== "string") return "a malformed action payload";
    return requiresConfirmation(inner) ? inner : null;
  }
  return requiresConfirmation(name) ? name : null;
}

/**
 * Execute a game tool with confirmation-gating for irreversible actions and
 * automatic post-tool bookkeeping. Single choke-point shared by the HTTP
 * `/tool` endpoint and the MCP server.
 *
 * `opts.probeId` scopes the call to one of the operator's other probes; omit it
 * (or pass null) for the main probe. The same value drives both execution and
 * bookkeeping, so the two can't drift apart.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  opts?: { confirm?: boolean; probeId?: number | null },
): Promise<RunToolResult> {
  const gatedOn = consentRequiredFor(name, args);
  if (gatedOn && !opts?.confirm) {
    return { requiresConfirmation: true, tool: name, gatedOn };
  }
  const probeId = opts?.probeId ?? null;
  const result = await executeTool(name, args, probeId);
  await afterTool(name, args, result, probeId);
  return result;
}
