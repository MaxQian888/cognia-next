/**
 * Snapshot creation and materialization.
 *
 * createSnapshotFromFiles: for each accepted import file, stat → read →
 * hash → stat again. A file that changes mid-read fails the whole snapshot
 * with SOURCE_CHANGED_DURING_SNAPSHOT — never a half-consistent tree.
 * File bytes go to CAS; the manifest is canonical-JSON hashed to treeHash.
 *
 * materializeSnapshot: writes CAS bytes back to a working directory for a
 * build, refusing any path that would escape the workdir.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  sha256Hex,
  utcNowIso,
  WorkbenchError,
  type SnapshotFile,
  type SnapshotManifest,
} from "@latexwb/contracts";
import { inTransaction, type BlobStore, type Row, type Scope, type WorkbenchStore } from "@latexwb/storage";
import { classifyRole, type ImportAcceptance } from "./import.ts";
import { isValidProjectPath, toProjectPath } from "./paths.ts";

export interface SnapshotHooks {
  /**
   * Test/diagnostic seam invoked after a file's bytes were read and hashed
   * but before the post-read stat check. Lets a test mutate the source file
   * to exercise SOURCE_CHANGED_DURING_SNAPSHOT deterministically.
   */
  afterRead?: (projectPath: string, hostPath: string) => void;
}

export interface CreatedSnapshot {
  snapshotId: string;
  treeHash: string;
  files: SnapshotFile[];
}

interface FileFingerprint {
  mtimeMs: number;
  size: number;
  ino: number;
}

function fingerprint(path: string): FileFingerprint {
  const s = statSync(path);
  return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

/**
 * Hash accepted files into CAS and persist a snapshot + head update in one
 * transaction. The parent snapshot is the project's current head.
 */
export function createSnapshotFromFiles(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  scope: Scope;
  files: ImportAcceptance[];
  roles?: Map<string, string>;
  hooks?: SnapshotHooks | undefined;
}): CreatedSnapshot {
  const { store, blobs, scope, files, hooks } = options;
  const snapshotId = `snap-${randomUUID()}`;
  const manifestFiles: SnapshotFile[] = [];

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (!isValidProjectPath(file.path)) {
      throw new WorkbenchError(
        ERROR_CODES.UNSUPPORTED_PATH,
        `refusing to snapshot invalid project path ${JSON.stringify(file.path)}`,
      );
    }
    const before = fingerprint(file.hostPath);
    const bytes = readFileSync(file.hostPath);
    const hash = sha256Hex(bytes);
    hooks?.afterRead?.(file.path, file.hostPath);
    const after = fingerprint(file.hostPath);
    if (!sameFingerprint(before, after)) {
      throw new WorkbenchError(
        ERROR_CODES.SOURCE_CHANGED_DURING_SNAPSHOT,
        `source file ${file.path} changed while snapshotting (size/mtime/ino drift)`,
        { retryable: true },
      );
    }
    blobs.put(bytes);
    manifestFiles.push({
      path: file.path,
      sha256: hash,
      bytes: bytes.length,
      role: (options.roles?.get(file.path) ?? classifyRole(file.path)) as SnapshotFile["role"],
      executable: false,
    });
  }

  const project = store.getProject(scope);
  const parentSnapshotId = (project?.["head_snapshot_id"] as string | null) ?? null;
  const createdAt = utcNowIso();
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    id: snapshotId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    parentSnapshotId,
    treeHash: "", // filled below
    createdAt,
    files: manifestFiles,
  };
  manifest.treeHash = digestJson({ files: manifestFiles, parentSnapshotId, projectId: scope.projectId });

  inTransaction(store.db, () => {
    store.insertSnapshot(scope, {
      snapshotId,
      parentSnapshotId,
      treeHash: manifest.treeHash,
      manifestJson: canonicalJson(manifest),
      createdAt,
    });
    store.insertSnapshotFiles(
      scope,
      snapshotId,
      manifestFiles.map((f) => ({
        path: f.path,
        blobHash: f.sha256,
        sizeBytes: f.bytes,
        role: f.role,
      })),
    );
    if (project !== null) {
      const revision = project["revision"] as number;
      const prev = project["head_snapshot_id"] as string | null;
      if (!store.updateHeadSnapshot(scope, snapshotId, revision)) {
        throw new WorkbenchError(
          ERROR_CODES.STALE_BASE,
          "project head moved during snapshot commit",
          { retryable: true },
        );
      }
      store.emitProjectEventInTx(scope, {
        jobId: null,
        createdAt: utcNowIso(),
        eventJson: (seq) =>
          canonicalJson({
            schemaVersion: 1,
            seq,
            projectId: scope.projectId,
            jobId: null,
            snapshotId,
            attempt: null,
            fencingToken: null,
            type: "project.head-changed",
            timestamp: createdAt,
            payload: { previousSnapshotId: prev, snapshotId },
          }),
      });
    }
  });

  return { snapshotId, treeHash: manifest.treeHash, files: manifestFiles };
}

/**
 * Write every file of a snapshot into `workDir`. Paths come from the
 * manifest (already schema-shaped) but are re-validated — a corrupt record
 * must not escape the workdir.
 */
export function materializeSnapshot(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  scope: Scope;
  snapshotId: string;
  workDir: string;
}): string[] {
  const { store, blobs, scope, snapshotId, workDir } = options;
  const rows = store.listSnapshotFiles(scope, snapshotId);
  const root = resolve(workDir);
  const written: string[] = [];
  for (const row of rows) {
    const relPath = toProjectPath(row["path"] as string);
    if (!isValidProjectPath(relPath)) {
      throw new WorkbenchError(
        ERROR_CODES.UNSUPPORTED_PATH,
        `snapshot ${snapshotId} contains invalid path ${JSON.stringify(row["path"])}`,
      );
    }
    const dest = resolve(root, relPath);
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw new WorkbenchError(
        ERROR_CODES.UNSUPPORTED_PATH,
        `snapshot path ${relPath} escapes the work directory`,
      );
    }
    const bytes = blobs.getVerified(row["blob_hash"] as string);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    written.push(relPath);
  }
  return written;
}

export function snapshotFileRows(store: WorkbenchStore, scope: Scope, snapshotId: string): Row[] {
  return store.listSnapshotFiles(scope, snapshotId);
}

/** Read one file's bytes from CAS by snapshot path. */
export function readSnapshotFile(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  scope: Scope;
  snapshotId: string;
  path: string;
}): Uint8Array | null {
  const { store, blobs, scope, snapshotId, path } = options;
  const row = store
    .listSnapshotFiles(scope, snapshotId)
    .find((r) => r["path"] === path);
  if (row === undefined) return null;
  return blobs.getVerified(row["blob_hash"] as string);
}
