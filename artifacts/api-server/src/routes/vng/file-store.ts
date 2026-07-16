import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "node:crypto";

// NOTE: do NOT import the pino logger here. This module is in the MCP
// subprocess's import graph, and pino writes to stdout — which is that
// subprocess's JSON-RPC channel — and is deliberately excluded from the
// neumann-mcp.mjs bundle. Log with console.error (stderr) only.

// Checked most-specific first:
//   VNG_DATA_DIR — set by /command on the stdio MCP subprocess, which the Claude
//     CLI spawns with a different cwd. It wins so a subprocess running under
//     Electron shares its parent's dir instead of re-deriving one.
//   DATA_DIR — set by the Electron app, whose packaged cwd is unpredictable.
const dataDirEnv = process.env.VNG_DATA_DIR || process.env.DATA_DIR;
export const DATA_DIR = dataDirEnv
  ? path.resolve(dataDirEnv)
  : path.resolve(process.cwd(), "data");

/** A data file could not be read or written safely. Distinct from ENOENT, which
 *  is treated as "empty" rather than an error. */
export class FileStoreError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FileStoreError";
  }
}

const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * Read a file's raw bytes. Returns null ONLY for ENOENT (legitimately absent).
 * A transient Windows lock (AV / Search indexer holding the handle) is retried
 * a few times; anything still failing throws rather than masquerading as absent.
 * This is the fail-closed foundation: a read we couldn't complete must never be
 * mistaken for an empty file, or the next write would erase real data.
 */
async function readRaw(name: string): Promise<string | null> {
  const file = path.join(DATA_DIR, name);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      if (TRANSIENT.has(err?.code) && attempt < 4) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      throw new FileStoreError(`cannot read ${name} (${err?.code})`, file, err);
    }
  }
}

/** Parse raw JSON array bytes. null (ENOENT) → the empty value. A parse error or
 *  a non-array throws — a corrupt file is never silently coerced to []. */
function parseRows<T>(name: string, raw: string | null, empty: T): T {
  if (raw === null) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FileStoreError(
      `${name} is not valid JSON — refusing to read; file left untouched`,
      path.join(DATA_DIR, name),
      err,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FileStoreError(
      `${name} is not a JSON array (got ${parsed === null ? "null" : typeof parsed})`,
      path.join(DATA_DIR, name),
    );
  }
  return parsed as T;
}

/** Read + parse in one step (pure readers). Fail-closed per readRaw/parseRows. */
async function readJson<T>(name: string, empty: T): Promise<T> {
  return parseRows(name, await readRaw(name), empty);
}

/**
 * Durable replace: serialize, write to a unique temp in the same dir, fsync,
 * then atomically rename over the target. A crash or concurrent read can never
 * observe a partial file — the failure mode that has already destroyed sector
 * history in this project once. The uuid keeps two writers (this process's own
 * concurrency, or the MCP subprocess) from colliding on the temp itself.
 */
async function writeJson<T>(name: string, data: T): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  await ensureDir();
  const file = path.join(DATA_DIR, name);
  const tmp = path.join(
    DATA_DIR,
    `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    const fh = await fs.open(tmp, "wx");
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close(); // must close before rename on Windows
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (err: any) {
        if (!TRANSIENT.has(err?.code) || attempt >= 4) {
          throw new FileStoreError(
            `cannot replace ${name} (${err?.code})`,
            file,
            err,
          );
        }
        await sleep(20 * (attempt + 1));
      }
    }
  } finally {
    await fs.unlink(tmp).catch(() => {}); // never leave a temp behind
  }
}

// Per-file promise chain. Serializes read-modify-write cycles WITHIN this
// process — e.g. the ~16 concurrent recordSector calls the /sectors/refresh
// button fans out — so same-process callers never even contend for the
// cross-process lock below. This alone is not enough: the api-server and the
// spawned MCP subprocess write the same files from two OS processes.
const chains = new Map<string, Promise<unknown>>();
function withFileLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of the predecessor's fate
  chains.set(
    name,
    next.then(
      () => {},
      () => {},
    ),
  ); // a rejection must not poison the queue
  return next;
}

const LOCK_STALE_MS = 10_000; // a read-modify-write of a local file is milliseconds
const LOCK_WAIT_MS = 15_000; // give up rather than hang a request forever

/**
 * Cross-process mutual exclusion for one data file, via an O_EXCL lock file.
 * Held only across a read-modify-write (never across a game API call), so the
 * critical section is milliseconds. A process killed mid-write (the MCP
 * subprocess is routinely killed on command completion) can orphan the lock; the
 * staleness check reclaims it. The stale window (>10s) is far longer than any
 * real local-file RMW, so it can't cause two live holders.
 */
async function withCrossProcessLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureDir();
  const lock = path.join(DATA_DIR, `.${name}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lock, "wx"); // atomic exclusive create
      try {
        await fh.writeFile(String(process.pid));
      } finally {
        await fh.close();
      }
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        throw new FileStoreError(
          `cannot lock ${name} (${err?.code})`,
          lock,
          err,
        );
      }
      // Held by someone. Reclaim if the holder died and left it stale.
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new FileStoreError(`timed out waiting for lock on ${name}`, lock);
      }
      // Small, pid-staggered backoff to avoid two processes lockstepping.
      await sleep(10 + (process.pid % 25));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

/**
 * Read-modify-write a JSON array file safely. `mutate` gets the current rows and
 * returns the caller's result plus whether to persist.
 *
 * `withFileLock` serializes cycles within this process; `withCrossProcessLock`
 * serializes them against the other process. Together they make the whole
 * read-modify-write atomic across both writers — which is what stops a poller
 * `resolve` and an MCP `schedule_action` from clobbering or resurrecting each
 * other's rows in pending-actions.json (a lost update there is a silently
 * re-fired or dropped action, not a cosmetic miss).
 */
async function mutateFile<T, R>(
  name: string,
  empty: T,
  mutate: (data: T) => { result: R; write: boolean },
): Promise<R> {
  return withFileLock(name, () =>
    withCrossProcessLock(name, async () => {
      const data = parseRows(name, await readRaw(name), empty);
      const { result, write } = mutate(data);
      if (write) await writeJson(name, data);
      return result;
    }),
  );
}

/** Monotonic next id. Never reuses an id even after a row is removed, and avoids
 *  Math.max(...) spread pitfalls (NaN from a malformed row, huge-array RangeError). */
function nextId(rows: readonly { id: number }[]): number {
  let max = 0;
  for (const r of rows) if (Number.isInteger(r.id) && r.id > max) max = r.id;
  return max + 1;
}

export type DetachedContainer = {
  id: number;
  containerId: string; // inventory item ID (e.g. "container-itm_craft_xxx")
  sectorObjectId: string; // sector object ID used for mining target & recovery: "detached-container-" + containerId
  containerName: string;
  mannyId: string;
  mannyName: string;
  sectorX: number;
  sectorY: number;
  sectorZ: number;
  detachedAt: string;
  status: "floating" | "recovered" | "unknown";
  anchorObjectId: string | null; // asteroid/planet object ID it is attached to (from sector after detach)
  anchorObjectName: string | null;
  notes: string | null;
};

// ── Pending / Deferred Actions ────────────────────────────────────────────────

export type ConditionMannyIdle = {
  type: "manny_idle";
  mannyId: string;
  mannyName: string;
  /** Optional: also wait until ALL of these item types exist in probe inventory (for dependency chains) */
  requireItems?: string[];
};
export type ConditionProbeIdle = { type: "probe_idle" };
export type PendingCondition = ConditionMannyIdle | ConditionProbeIdle;

export type ActionMoveProbe = {
  type: "move_probe";
  x: number;
  y: number;
  z: number;
};
export type ActionCraftItem = {
  type: "craft_item";
  mannyId: string;
  recipe: string;
};
export type ActionMineResources = {
  type: "mine_resources";
  mannyId: string;
  objectId: string;
  resources: string[];
  targetAmount: number;
  targetContainerId?: string;
};
export type ActionDetachContainer = {
  type: "detach_container";
  mannyId: string;
  containerId: string;
};
export type ActionRecoverContainer = {
  type: "recover_container";
  mannyId: string;
  objectId: string;
};
export type PendingActionPayload =
  | ActionMoveProbe
  | ActionCraftItem
  | ActionMineResources
  | ActionDetachContainer
  | ActionRecoverContainer;

export type PendingAction = {
  id: number;
  description: string;
  createdAt: string;
  condition: PendingCondition;
  action: PendingActionPayload;
  // Which probe this action targets; null = the operator's main probe. Optional
  // ON DISK — the rows written before multi-probe have no such key, and a missing
  // key provably means "main" (they predate any second probe). The poller
  // coalesces `?? null`. It is REQUIRED at the addPendingAction call site (see
  // its signature) so the schedule_action handler can't silently drop the probe
  // it's scoped to — an upstream regen that omits the arg fails tsc here.
  probeId?: number | null;
  // "cancelled" is a terminal status, not a row removal — see cancelPendingAction.
  status: "pending" | "triggered" | "failed" | "cancelled";
  triggeredAt?: string;
  error?: string;
};

const PENDING_FILE = "pending-actions.json";

export async function getPendingActions(): Promise<PendingAction[]> {
  const all = await readJson<PendingAction[]>(PENDING_FILE, []);
  return all.filter((a) => a.status === "pending");
}

/** Recent terminal rows (triggered / failed / cancelled), newest first. So the
 *  operator can see that a scheduled order failed or was cancelled instead of it
 *  silently vanishing from the pending list. */
export async function getRecentTerminalActions(
  limit = 20,
): Promise<PendingAction[]> {
  const all = await readJson<PendingAction[]>(PENDING_FILE, []);
  return all
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.triggeredAt ?? "").localeCompare(a.triggeredAt ?? ""))
    .slice(0, limit);
}

export async function addPendingAction(
  // probeId is optional on the type (legacy rows lack it) but REQUIRED here: the
  // intersection re-adds it as a mandatory field the derived Omit would have left
  // optional. This is the tripwire — a caller (or an upstream-regenerated
  // schedule_action handler) that forgets to pass the probe it's scoped to won't
  // compile, rather than silently scheduling every probe's work onto the main one.
  entry: Omit<PendingAction, "id" | "createdAt" | "status" | "probeId"> & {
    probeId: number | null;
  },
): Promise<PendingAction> {
  return mutateFile<PendingAction[], PendingAction>(
    PENDING_FILE,
    [],
    (rows) => {
      const newRow: PendingAction = {
        ...entry,
        id: nextId(rows),
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      rows.push(newRow);
      return { result: newRow, write: true };
    },
  );
}

export async function resolvePendingAction(
  id: number,
  result: { status: "triggered" | "failed"; error?: string },
): Promise<void> {
  return mutateFile<PendingAction[], void>(PENDING_FILE, [], (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    // Only a still-pending row may be resolved. Refusing a terminal row stops a
    // cross-process resurrection (or a stale caller) from stamping "triggered"
    // onto a row that was already cancelled or resolved.
    if (idx === -1 || rows[idx].status !== "pending") {
      if (idx !== -1)
        console.error(
          `[file-store] refusing to resolve action ${id}: status=${rows[idx].status}`,
        );
      return { result: undefined, write: false };
    }
    rows[idx].status = result.status;
    rows[idx].triggeredAt = new Date().toISOString();
    if (result.error) rows[idx].error = result.error;
    return { result: undefined, write: true };
  });
}

export async function cancelPendingAction(id: number): Promise<boolean> {
  return mutateFile<PendingAction[], boolean>(PENDING_FILE, [], (rows) => {
    const idx = rows.findIndex((r) => r.id === id && r.status === "pending");
    if (idx === -1) return { result: false, write: false };
    // Terminal status, NOT a splice: removing the row would let nextId reuse its
    // id, so a stale cancel/resolve could later hit a different action.
    rows[idx].status = "cancelled";
    return { result: true, write: true };
  });
}

/**
 * One record per sector, keyed by coordinates and scoped to the operator's main
 * probe: the counters mean "times the main probe observed this sector", and only
 * main-probe observations write here.
 *
 * Per-probe exploration history is NOT tracked here — the game API already
 * serves it authoritatively at `GET /api/probe/{probeId}/visited-sectors`. Ask
 * it rather than growing a second, staler copy in this file.
 */
export type VisitedSector = {
  // A display/order handle only — every lookup and the recordSector upsert match
  // on (sectorX, sectorY, sectorZ), never on id. So the one duplicate id:7 in the
  // live file (a leftover from the f46fc89 text-merge of two tracked JSON arrays,
  // NOT a runtime race) is inert; renumbering isn't worth a backup + downtime.
  id: number;
  sectorX: number;
  sectorY: number;
  sectorZ: number;
  firstVisitedAt: string;
  lastVisitedAt: string;
  visitCount: number;
  objects: object[];
  resourceSummary: string[];
};

const CONTAINERS_FILE = "detached-containers.json";
const SECTORS_FILE = "visited-sectors.json";

/** Derive the sector object ID from an inventory container ID. */
export function toSectorObjectId(containerId: string): string {
  return `detached-container-${containerId}`;
}

export async function getContainers(): Promise<DetachedContainer[]> {
  return readJson<DetachedContainer[]>(CONTAINERS_FILE, []);
}

export async function addContainer(
  entry: Omit<DetachedContainer, "id" | "detachedAt">,
): Promise<DetachedContainer> {
  return mutateFile<DetachedContainer[], DetachedContainer>(
    CONTAINERS_FILE,
    [],
    (rows) => {
      const newRow: DetachedContainer = {
        ...entry,
        id: nextId(rows),
        detachedAt: new Date().toISOString(),
      };
      rows.push(newRow);
      return { result: newRow, write: true };
    },
  );
}

export async function updateContainerStatus(
  id: number,
  update: { status?: string; notes?: string },
): Promise<void> {
  return mutateFile<DetachedContainer[], void>(CONTAINERS_FILE, [], (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return { result: undefined, write: false };
    if (update.status) rows[idx].status = update.status as any;
    if (update.notes !== undefined) rows[idx].notes = update.notes;
    return { result: undefined, write: true };
  });
}

export async function updateContainerAnchor(
  id: number,
  anchorObjectId: string,
  anchorObjectName: string | null,
): Promise<void> {
  return mutateFile<DetachedContainer[], void>(CONTAINERS_FILE, [], (rows) => {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return { result: undefined, write: false };
    rows[idx].anchorObjectId = anchorObjectId;
    rows[idx].anchorObjectName = anchorObjectName;
    return { result: undefined, write: true };
  });
}

/**
 * Mark a container as recovered. Matches by sectorObjectId first,
 * then falls back to containerId (since the recovery tool uses the sector object ID).
 */
export async function markContainerRecovered(objectId: string): Promise<void> {
  return mutateFile<DetachedContainer[], void>(CONTAINERS_FILE, [], (rows) => {
    let changed = false;
    for (const row of rows) {
      if (
        row.status === "floating" &&
        (row.sectorObjectId === objectId || row.containerId === objectId)
      ) {
        row.status = "recovered";
        changed = true;
      }
    }
    return { result: undefined, write: changed };
  });
}

export async function getFloatingContainers(
  sectorX: number,
  sectorY: number,
  sectorZ: number,
): Promise<DetachedContainer[]> {
  const rows = await getContainers();
  return rows.filter(
    (r) =>
      r.status === "floating" &&
      r.sectorX === sectorX &&
      r.sectorY === sectorY &&
      r.sectorZ === sectorZ,
  );
}

export async function getSectors(): Promise<VisitedSector[]> {
  return readJson<VisitedSector[]>(SECTORS_FILE, []);
}

/**
 * Record a main-probe observation of a sector. Callers must not invoke this for
 * a secondary probe — see the `VisitedSector` docs and the guard in `afterTool`.
 */
export async function recordSector(
  x: number,
  y: number,
  z: number,
  objects: object[],
): Promise<void> {
  const resourceSummary: string[] = Array.from(
    new Set((objects as any[]).flatMap((o) => o.resourceTypes ?? [])),
  );

  // Store full object detail so the MAP tab can show everything
  const simplified = (objects as any[]).map((o) => {
    const base: Record<string, unknown> = {
      id: o.id ?? null,
      type: o.type,
      name: o.name ?? null,
      estimated: o.estimated ?? false,
      summary: o.summary ?? null,
      dangerLevel: o.dangerLevel ?? null,
      resourceTypes: o.resourceTypes ?? [],
    };

    // Solar system — keep star/planet list from bookmarkTargets
    if (o.type === "solar_system") {
      base.starCount = o.starCount ?? 0;
      base.planetCount = o.planetCount ?? 0;
      base.orbitalBodyCount = o.orbitalBodyCount ?? 0;
      base.bodies = (o.bookmarkTargets ?? []).map((b: any) => ({
        id: b.id,
        type: b.type,
        name: b.name ?? null,
        category: b.category ?? null,
        mass: b.mass,
        massUnit: b.massUnit,
        radius: b.radius,
        radiusUnit: b.radiusUnit,
        habitabilityScore: b.habitabilityScore ?? null,
        intelligentLife: b.intelligentLife ?? null,
      }));
    }

    // Planet
    if (o.type === "planet") {
      base.category = o.category ?? null;
      base.habitabilityScore = o.habitabilityScore ?? null;
      base.intelligentLife = o.intelligentLife ?? null;
      base.mass = o.mass ?? null;
      base.massUnit = o.massUnit ?? null;
      base.radius = o.radius ?? null;
      base.radiusUnit = o.radiusUnit ?? null;
    }

    // Asteroid
    if (o.type === "asteroid") {
      base.composition = o.composition ?? null;
      base.sizeCategory = o.sizeCategory ?? null;
      base.mass = o.mass ?? null;
      base.radius = o.radius ?? null;
      base.resourceAmounts = o.resourceAmounts ?? null;
      base.resourceComposition = o.resourceComposition ?? null;
    }

    // Detached container
    if (o.type === "detached_container") {
      base.capacity = o.capacity ?? null;
      base.mode = o.mode ?? null;
      base.targetObjectId = o.targetObjectId ?? null;
      base.salvageable = o.salvageable ?? false;
    }

    // SCUT relay — preserve range + network so the globe can draw coverage rings
    if (o.type === "scut_relay") {
      base.status = o.status ?? null;
      base.coverageRadiusSectors = o.coverageRadiusSectors ?? null;
      base.network = o.network ?? null;
      base.createdByProbeId = o.createdByProbeId ?? null;
      base.createdByProbeName = o.createdByProbeName ?? null;
      base.activatedAt = o.activatedAt ?? null;
    }

    // Star / black hole
    if (o.type === "star" || o.type === "black_hole") {
      base.mass = o.mass ?? null;
      base.massUnit = o.massUnit ?? null;
      base.radius = o.radius ?? null;
      base.radiusUnit = o.radiusUnit ?? null;
    }

    // Dust cloud / nebula
    if (o.type === "dust_cloud") {
      base.radius = o.radius ?? null;
      base.radiusUnit = o.radiusUnit ?? null;
    }

    return base;
  });

  const now = new Date().toISOString();

  return mutateFile<VisitedSector[], void>(SECTORS_FILE, [], (rows) => {
    const idx = rows.findIndex(
      (r) => r.sectorX === x && r.sectorY === y && r.sectorZ === z,
    );
    if (idx !== -1) {
      const row = rows[idx];
      row.objects = simplified;
      row.resourceSummary = resourceSummary;
      row.lastVisitedAt = now;
      row.visitCount += 1;
    } else {
      rows.push({
        id: nextId(rows),
        sectorX: x,
        sectorY: y,
        sectorZ: z,
        firstVisitedAt: now,
        lastVisitedAt: now,
        visitCount: 1,
        objects: simplified,
        resourceSummary,
      });
    }
    return { result: undefined, write: true };
  });
}
