/**
 * Project lifecycle: host-side import (scan → snapshot → head) on top of
 * scanImportDirectory + createSnapshotFromFiles. The returned report lists
 * every rejected and excluded entry — completeness claims are only valid
 * alongside that accounting.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  utcNowIso,
  WorkbenchError,
  type HostPolicy,
  type ProjectConfig,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import {
  defaultProjectId,
  limitsFromHostPolicy,
  scanImportDirectory,
  type ImportScanResult,
} from "./import.ts";
import { createSnapshotFromFiles, type CreatedSnapshot, type SnapshotHooks } from "./snapshot.ts";

export interface ImportReport {
  projectId: string;
  snapshotId: string;
  treeHash: string;
  createdProject: boolean;
  accepted: { path: string; sizeBytes: number; role: string }[];
  rejected: ImportScanResult["rejected"];
  excluded: ImportScanResult["excluded"];
  totalBytes: number;
}

export function defaultProjectConfig(projectId: string): ProjectConfig {
  return {
    schemaVersion: 1,
    projectId,
    languages: ["en"],
    domains: [],
    targets: [],
    protectedContent: {
      math: false,
      citationKeys: false,
      labels: false,
      reportedResults: false,
      quotes: false,
      templateFiles: false,
      rawAssets: false,
    },
    resources: { include: [], exclude: [] },
    qualityProfile: "draft",
  };
}

export function importFromDirectory(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  hostPath: string;
  projectId?: string | undefined;
  hostPolicy: HostPolicy | null;
  hooks?: SnapshotHooks;
}): ImportReport {
  const { store, blobs, ctx, hostPath, hostPolicy, hooks } = options;
  requireCapability(ctx, "project.write");
  const projectId = options.projectId ?? defaultProjectId(hostPath);
  const scope: Scope = { workspaceId: ctx.workspaceId, projectId };

  const scan = scanImportDirectory(hostPath, limitsFromHostPolicy(hostPolicy));
  if (scan.accepted.length === 0) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `import of ${hostPath} accepted zero files (rejected=${scan.rejected.length} excluded=${scan.excluded.length})`,
    );
  }

  const existing = store.getProject(scope);
  const createdProject = existing === null;
  // Register the import root as the project's host root — a host-owned
  // column on projects, NOT part of ProjectConfig (project content must
  // never widen its own host-write surface). Materialization may only
  // write inside this realpath (materialize.ts revalidates). Existing
  // projects keep theirs; a missing host_root (pre-0003 import) is
  // backfilled from this import source.
  if (createdProject) {
    store.createProject(
      scope,
      canonicalJson(defaultProjectConfig(projectId)),
      utcNowIso(),
      realpathSync(resolve(hostPath)),
    );
  } else if (existing["host_root"] === null) {
    store.setProjectHostRoot(scope, realpathSync(resolve(hostPath)));
  }

  const snapshot: CreatedSnapshot = createSnapshotFromFiles({
    store,
    blobs,
    scope,
    files: scan.accepted.map((a) => ({ path: a.path, hostPath: a.hostPath, sizeBytes: a.sizeBytes })),
    hooks,
  });

  return {
    projectId,
    snapshotId: snapshot.snapshotId,
    treeHash: snapshot.treeHash,
    createdProject,
    accepted: scan.accepted.map((a) => ({
      path: a.path,
      sizeBytes: a.sizeBytes,
      role: snapshot.files.find((f) => f.path === a.path)?.role ?? "raw-asset",
    })),
    rejected: scan.rejected,
    excluded: scan.excluded,
    totalBytes: scan.totalBytes,
  };
}
