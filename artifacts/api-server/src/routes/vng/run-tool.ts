import * as client from "./client.js";
import { executeTool } from "./tools.js";
import {
  addContainer,
  markContainerRecovered,
  recordSector,
  toSectorObjectId,
  updateContainerAnchor,
} from "./file-store.js";

/**
 * Tools that permanently change game state and must never run without an
 * explicit confirmation. These are deliberately NOT exposed via the MCP server,
 * so the headless Claude brain cannot invoke them at all.
 */
export const IRREVERSIBLE = new Set<string>([
  "move_probe",
  "jettison_item",
  "detach_container",
  "drop_container_on_asteroid",
  "salvage_object",
  "recall_manny",
]);

/**
 * Post-tool bookkeeping, extracted verbatim (behaviour-preserving) from the old
 * inline OpenAI loop in index.ts. Persists local tracking state after a
 * successful tool call: detached-container registry, container recovery,
 * and visited-sector snapshots.
 *
 * Self-contained: it fetches whatever fresh state it needs rather than relying
 * on a caller-provided snapshot, so it works from both the HTTP endpoint and
 * the MCP subprocess.
 */
export async function afterTool(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): Promise<void> {
  if (name === "detach_container") {
    const mannyId = args.manny_id as string;
    const containerId = args.container_id as string;

    // Resolve display names + current sector from fresh state.
    const [probeResp, manniesResp] = await Promise.all([
      client.getProbe(),
      client.getMannies(),
    ]);
    const probe = probeResp.probe;
    const sector = probe.sector?.relative ?? { x: 0, y: 0, z: 0 };
    const inv = probe.inventory ?? {};
    const mannyInfo = (manniesResp.mannies ?? []).find((m: any) => m.id === mannyId);
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
    client
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

  if (name === "scan_sector") {
    const scannedObjects: any[] = (result as any)?.sector?.objects ?? [];
    await recordSector(
      args.x as number,
      args.y as number,
      args.z as number,
      scannedObjects,
    ).catch(() => {});
    return;
  }

  if (name === "get_game_state") {
    const gs = result as any;
    const gsObjects = gs?.sector?.objects ?? [];
    const gsSector = gs?.probe?.sector ?? { x: 0, y: 0, z: 0 };
    await recordSector(
      gsSector.x,
      gsSector.y,
      gsSector.z,
      gsObjects,
    ).catch(() => {});
    return;
  }
}

export type RunToolResult =
  | { requiresConfirmation: true; tool: string }
  | unknown;

/**
 * Execute a game tool with confirmation-gating for irreversible actions and
 * automatic post-tool bookkeeping. Single choke-point shared by the HTTP
 * `/tool` endpoint and the MCP server.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  opts?: { confirm?: boolean },
): Promise<RunToolResult> {
  if (IRREVERSIBLE.has(name) && !opts?.confirm) {
    return { requiresConfirmation: true, tool: name };
  }
  const result = await executeTool(name, args);
  await afterTool(name, args, result);
  return result;
}
