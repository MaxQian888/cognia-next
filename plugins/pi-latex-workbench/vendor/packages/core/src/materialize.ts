/**
 * Materialization journal (M2): sync a logical snapshot into a host working
 * directory with crash recovery.
 *
 * Protocol:
 *   staging write → journal 'prepared' → 'applying' → per-file atomic
 *   rename → 'completed'. A process that dies mid-apply leaves the journal
 *   row; `recoverMaterialization` finishes the apply (staging is intact and
 *   verified) or rolls back from backups. Terminal states are honest:
 *   'completed' | 'conflict' (nothing applied) | 'rolled-back' | 'unrestorable'
 *   (rollback impossible — detail_json lists the affected paths and the host
 *   directory must not be trusted as a baseline).
 *
 *   Builds never read the host dir — they materialize from CAS directly —
 *   so a half-applied host tree is never a build input.
 *
 * AUTHORIZATION: requires project.write AND a hostDir inside the project's
 * registered hostRoot (the realpath recorded at import). Anything outside,
 * symlinked, or escaping is rejected — the tool layer cannot aim CAS bytes
 * at an arbitrary directory.
 *
 * External edits are detected by hashing host files against the last
 * COMPLETED journal's recorded hashes; drift on a path the journal would
 * overwrite is a STALE_BASE conflict, not a silent clobber.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  sha256Hex,
  utcNowIso,
  WorkbenchError,
} from "@latexwb/contracts";
import type { BlobStore, Row, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { isValidProjectPath } from "./paths.ts";

const JOURNAL_DIR_NAME = ".latexwb-materialize";

export interface JournalItem {
  path: string;
  action: "write" | "delete";
  /** sha256 of desired content (null for delete). */
  sha256: string | null;
  /** sha256 of pre-existing host content, or null when the file was absent. */
  priorSha256: string | null;
}

interface JournalPlan {
  journalId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  state: string;
  items: JournalItem[];
}

function journalDir(hostDir: string, journalId: string): string {
  return join(hostDir, JOURNAL_DIR_NAME, journalId);
}

/** Remove a finished journal's data, plus the parent dir once it is empty. */
function cleanupJournalDir(hostDir: string, journalId: string): void {
  rmSync(journalDir(hostDir, journalId), { recursive: true, force: true });
  try {
    rmdirSync(join(hostDir, JOURNAL_DIR_NAME));
  } catch {
    // keep a non-empty journal dir (other journals may still be in flight)
  }
}

function hostFileSha(path: string): string | null {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Reject a write target whose path under hostDir passes through a symlinked
 * directory — a symlink inside the (realpath-validated) root can redirect a
 * rename outside it. Walks ancestors with lstat so links are seen as links;
 * the first missing component ends the walk (nothing deeper can exist).
 * The final component is not checked: rename replaces the link node itself
 * rather than following it.
 */
function assertNoSymlinkedAncestors(hostDir: string, relPath: string): void {
  const parts = relPath.split("/").slice(0, -1);
  let cur = hostDir;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        `materialize path ${JSON.stringify(relPath)} passes through symlinked directory ${cur}`,
        { retryable: false },
      );
    }
  }
}

function listHostFiles(hostDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === JOURNAL_DIR_NAME) continue;
      const p = join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.set(r, sha256Hex(readFileSync(p)));
    }
  };
  if (existsSync(hostDir)) walk(hostDir, "");
  return out;
}

function parseJournal(row: Row): JournalPlan {
  return {
    journalId: row["journal_id"] as string,
    fromSnapshotId: row["from_snapshot_id"] as string,
    toSnapshotId: row["to_snapshot_id"] as string,
    state: row["state"] as string,
    items: JSON.parse(row["items_json"] as string) as JournalItem[],
  };
}

/**
 * Resolve the project's registered host root and prove `hostDir` is inside
 * it. Both sides go through realpath so a symlinked ancestor cannot fake
 * containment. Returns the validated real path.
 */
function authorizedHostDir(store: WorkbenchStore, scope: Scope, hostDir: string): string {
  const project = store.getProject(scope);
  if (project === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `project ${scope.projectId} not found`);
  }
  // The host root is a host-owned column, never part of ProjectConfig —
  // project-supplied config must not be able to widen its own host writes.
  const hostRoot = project["host_root"] as string | null;
  if (hostRoot === null) {
    throw new WorkbenchError(
      ERROR_CODES.POLICY_DENIED,
      `project ${scope.projectId} has no registered host root — materialization requires a project imported from a host directory`,
      { retryable: false },
    );
  }
  // The target may not exist yet — resolve its nearest existing ancestor.
  let probe = resolve(hostDir);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `host directory ${hostDir} cannot be resolved`);
    }
    probe = parent;
  }
  const realDir = join(realpathSync(probe), resolve(hostDir).slice(probe.length));
  const realRoot = realpathSync(hostRoot);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new WorkbenchError(
      ERROR_CODES.POLICY_DENIED,
      `host directory ${hostDir} resolves outside the project host root ${realRoot}`,
      { retryable: false },
    );
  }
  return realDir;
}

/**
 * Nearest ancestor of `snapshotId` (inclusive) that was not produced by an
 * applied patch — i.e. a host-directory scan (import / re-snapshot).
 */
function importAncestor(store: WorkbenchStore, scope: Scope, snapshotId: string): string | null {
  let current: string | null = snapshotId;
  for (let guard = 0; current !== null && guard < 10_000; guard += 1) {
    if (store.findPatchByResultSnapshot(scope, current) === null) return current;
    const row = store.getSnapshot(scope, current);
    current = (row?.["parent_snapshot_id"] as string | null | undefined) ?? null;
  }
  return null;
}

/**
 * Plan + execute a materialization. Returns the journal state reached;
 * throws STALE_BASE on external-edit conflict (journal recorded 'conflict').
 * `hooks.afterItem` is a test seam invoked after each atomic rename —
 * throwing there simulates a mid-apply crash for the recovery test.
 */
export function materializeToHost(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  snapshotId: string;
  hostDir: string;
  /**
   * Explicit host decision to adopt a non-empty directory we have never
   * synced: differing pre-existing files are still a conflict unless this
   * is true. Without it, first sync only writes absent paths.
   */
  takeover?: boolean;
  hooks?: { afterItem?: (index: number, item: JournalItem) => void } | undefined;
}): { journalId: string; state: string; items: number } {
  const { store, blobs, ctx, scope, snapshotId } = options;
  requireCapability(ctx, "project.write");
  const hostDir = authorizedHostDir(store, scope, options.hostDir);

  const rows = store.listSnapshotFiles(scope, snapshotId);
  if (rows.length === 0) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `snapshot ${snapshotId} has no files`);
  }

  // Baseline: only a COMPLETED journal defines what "ours" means — a
  // conflicted or rolled-back journal proves nothing was applied, so it
  // must not wedge later syncs (and keeps `takeover` meaningful).
  const prior = store.latestCompletedJournal(scope);
  const baseline = new Map<string, string>();
  let fromSnapshotId = snapshotId;
  if (prior !== null) {
    fromSnapshotId = prior["to_snapshot_id"] as string;
    for (const item of JSON.parse(prior["items_json"] as string) as JournalItem[]) {
      if (item.action === "write" && item.sha256 !== null) baseline.set(item.path, item.sha256);
    }
  } else if (
    options.takeover !== true &&
    hostDir === realpathSync(store.getProject(scope)?.["host_root"] as string)
  ) {
    // Never synced back into the imported directory itself: the most
    // recent IMPORT defines what is on disk and "ours" — walk the snapshot's
    // ancestry past patch-produced snapshots to the scan it descends from.
    // Files still byte-identical to that import may be updated; anything
    // edited on disk since the import is an external change and conflicts.
    // (An explicit takeover keeps its adopt-the-directory meaning.)
    const imported = importAncestor(store, scope, snapshotId);
    if (imported !== null) {
      fromSnapshotId = imported;
      for (const r of store.listSnapshotFiles(scope, imported)) {
        baseline.set(r["path"] as string, r["blob_hash"] as string);
      }
    }
  }

  const desired = new Map<string, { sha256: string; role: string }>();
  for (const r of rows) {
    desired.set(r["path"] as string, { sha256: r["blob_hash"] as string, role: r["role"] as string });
  }

  const current = listHostFiles(hostDir);
  const conflicts: string[] = [];
  const items: JournalItem[] = [];

  for (const [path, want] of desired) {
    if (!isValidProjectPath(path)) {
      throw new WorkbenchError(ERROR_CODES.UNSUPPORTED_PATH, `snapshot path ${JSON.stringify(path)} is unsafe`);
    }
    const have = current.get(path) ?? null;
    const baseSha = baseline.get(path) ?? null;
    if (have === want.sha256) continue; // already in sync
    if (have !== null && baseSha !== null && have !== baseSha) {
      conflicts.push(path); // externally modified since last sync
      continue;
    }
    if (
      have !== null &&
      baseSha === null &&
      have !== want.sha256 &&
      (prior !== null || options.takeover !== true)
    ) {
      // Foreign content: either we have synced before (not ours) or this is
      // a first sync without an explicit takeover — never silently overwrite.
      conflicts.push(path);
      continue;
    }
    items.push({ path, action: "write", sha256: want.sha256, priorSha256: have });
  }
  for (const [path, baseSha] of baseline) {
    if (!desired.has(path)) {
      const have = current.get(path) ?? null;
      if (have !== null && have === baseSha) {
        items.push({ path, action: "delete", sha256: null, priorSha256: have });
      } else if (have !== null) {
        conflicts.push(path);
      }
    }
  }

  const journalId = `mj-${randomUUID()}`;
  if (conflicts.length > 0) {
    store.insertJournal(scope, {
      journalId,
      fromSnapshotId,
      toSnapshotId: snapshotId,
      state: "conflict",
      itemsJson: canonicalJson(items),
      detailJson: canonicalJson({ conflicts }),
      createdAt: utcNowIso(),
    });
    throw new WorkbenchError(
      ERROR_CODES.STALE_BASE,
      `host directory has externally modified files at: ${conflicts.join(", ")}`,
      { retryable: false },
    );
  }

  // Stage everything first; the journal row lands before any host rename.
  // The journal dir lives inside hostDir — if `.latexwb-materialize` itself
  // is a symlink, staging would escape the root. Check it once up front.
  assertNoSymlinkedAncestors(hostDir, `${JOURNAL_DIR_NAME}/${journalId}/x`);
  const jdir = journalDir(hostDir, journalId);
  const staging = join(jdir, "staging");
  const backup = join(jdir, "backup");
  mkdirSync(staging, { recursive: true });
  mkdirSync(backup, { recursive: true });
  for (const item of items) {
    if (item.action === "write") {
      const dest = join(staging, item.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, blobs.getVerified(item.sha256 as string));
    }
    if (item.priorSha256 !== null) {
      const src = join(hostDir, item.path);
      if (existsSync(src)) {
        const bdest = join(backup, item.path);
        mkdirSync(dirname(bdest), { recursive: true });
        writeFileSync(bdest, readFileSync(src));
      }
    }
  }

  store.insertJournal(scope, {
    journalId,
    fromSnapshotId,
    toSnapshotId: snapshotId,
    state: "prepared",
    itemsJson: canonicalJson(items),
    createdAt: utcNowIso(),
  });
  store.updateJournalState(scope, journalId, "applying");

  applyItems(hostDir, jdir, items, options.hooks);
  store.updateJournalState(scope, journalId, "completed");
  cleanupJournalDir(hostDir, journalId);
  return { journalId, state: "completed", items: items.length };
}

function applyItems(
  hostDir: string,
  jdir: string,
  items: JournalItem[],
  hooks?: { afterItem?: (index: number, item: JournalItem) => void } | undefined,
): void {
  const staging = join(jdir, "staging");
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as JournalItem;
    // A symlinked directory INSIDE the authorized root can redirect this
    // rename outside it — re-check ancestors per item, not just the root.
    assertNoSymlinkedAncestors(hostDir, item.path);
    const dest = join(hostDir, item.path);
    if (item.action === "write") {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(staging, item.path), dest);
    } else {
      try {
        unlinkSync(dest);
      } catch {
        /* already gone — idempotent */
      }
    }
    hooks?.afterItem?.(i, item);
  }
}

export interface RecoveryResult {
  journalId: string;
  state: "completed" | "conflict" | "rolled-back" | "unrestorable" | "prepared" | "applying" | "rolling-back";
  /** Paths whose original bytes could not be restored (unrestorable only). */
  unrestorable: string[];
}

/**
 * Recover the latest unfinished journal for this project: verify staging
 * integrity, then finish the apply; if staging is damaged, roll back the
 * already-applied items from backups. A rollback that cannot restore a
 * path lands in 'unrestorable' with the paths named — it must not look like
 * a clean 'conflict'.
 */
export function recoverMaterialization(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  hostDir: string;
}): RecoveryResult | null {
  const { store, ctx, scope } = options;
  requireCapability(ctx, "project.write");
  const hostDir = authorizedHostDir(store, scope, options.hostDir);
  const row = store.latestJournal(scope);
  if (row === null) return null;
  const journal = parseJournal(row);
  if (!["prepared", "applying", "rolling-back"].includes(journal.state)) {
    return { journalId: journal.journalId, state: journal.state as RecoveryResult["state"], unrestorable: [] };
  }

  const jdir = journalDir(hostDir, journal.journalId);
  const staging = join(jdir, "staging");
  const backup = join(jdir, "backup");

  // Verify staging: every pending write item must still exist with the
  // right bytes (either still staged or already renamed into place).
  let stagingOk = true;
  for (const item of journal.items) {
    if (item.action !== "write") continue;
    const stagedSha = hostFileSha(join(staging, item.path));
    const appliedSha = hostFileSha(join(hostDir, item.path));
    if (stagedSha !== item.sha256 && appliedSha !== item.sha256) {
      stagingOk = false;
      break;
    }
  }

  if (stagingOk) {
    // Finish the apply — renames are idempotent; items already applied are
    // skipped by content comparison.
    const remaining = journal.items.filter((item) => {
      if (item.action === "write") {
        return (
          hostFileSha(join(hostDir, item.path)) !== item.sha256 &&
          hostFileSha(join(staging, item.path)) === item.sha256
        );
      }
      return existsSync(join(hostDir, item.path));
    });
    applyItems(hostDir, jdir, remaining);
    store.updateJournalState(scope, journal.journalId, "completed");
    cleanupJournalDir(hostDir, journal.journalId);
    return { journalId: journal.journalId, state: "completed", unrestorable: [] };
  }

  // Staging damaged — roll back applied items from backups.
  store.updateJournalState(scope, journal.journalId, "rolling-back");
  const unrestorable: string[] = [];
  for (const item of journal.items) {
    // Same symlinked-ancestor guard as the forward apply — a rollback write
    // must not be redirected outside the root either.
    assertNoSymlinkedAncestors(hostDir, item.path);
    const dest = join(hostDir, item.path);
    const appliedSha = hostFileSha(dest);
    if (item.action === "write") {
      if (appliedSha === item.sha256) {
        // Item was applied — restore the prior content or remove the file.
        const bfile = join(backup, item.path);
        if (item.priorSha256 !== null) {
          if (existsSync(bfile)) {
            writeFileSync(dest, readFileSync(bfile));
          } else {
            unrestorable.push(item.path); // backup lost — cannot restore
          }
        } else {
          try {
            unlinkSync(dest);
          } catch {
            unrestorable.push(item.path);
          }
        }
      }
    } else if (appliedSha === null && item.priorSha256 !== null) {
      // Delete item whose removal happened — restore the prior file.
      const bfile = join(backup, item.path);
      if (existsSync(bfile)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(bfile));
      } else {
        unrestorable.push(item.path);
      }
    }
  }

  if (unrestorable.length > 0) {
    store.updateJournalState(
      scope,
      journal.journalId,
      "unrestorable",
      canonicalJson({ unrestorablePaths: unrestorable }),
    );
    cleanupJournalDir(hostDir, journal.journalId);
    return { journalId: journal.journalId, state: "unrestorable", unrestorable };
  }
  store.updateJournalState(scope, journal.journalId, "rolled-back");
  cleanupJournalDir(hostDir, journal.journalId);
  return { journalId: journal.journalId, state: "rolled-back", unrestorable: [] };
}
