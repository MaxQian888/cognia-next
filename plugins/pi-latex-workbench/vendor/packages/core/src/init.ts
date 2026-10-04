/**
 * Approved template initialization (M3). `project.init-approved` and
 * `latex_project init` copy ONLY entries of the host-owned template
 * registry at resources/templates/registry.json — every file's sha256 is
 * verified before it enters CAS. Nothing is downloaded; an unknown
 * templateId is NOT_FOUND, a drifted file is DIGEST_MISMATCH.
 *
 * Init targets an EMPTY project: when a head snapshot already exists the
 * call refuses — content creation after first content is patch work, not
 * init work.
 */
import { realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  sha256Hex,
  utcNowIso,
  WorkbenchError,
  type SnapshotRef,
  type Target,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { createSnapshotFromFiles } from "./snapshot.ts";
import { isValidProjectPath } from "./paths.ts";
import { defaultProjectConfig } from "./project.ts";

export interface TemplateFile {
  /** Project-relative path the content lands at. */
  path: string;
  sha256: string;
  /** File under resources/templates/ holding the approved bytes. */
  resource: string;
}

export interface TemplateEntry {
  id: string;
  description: string;
  entrypoint: string;
  engine: Target["engine"];
  bibliography: Target["bibliography"];
  outputProfileId: Target["outputProfileId"];
  files: TemplateFile[];
}

interface TemplateRegistryFile {
  schemaVersion: number;
  templates: TemplateEntry[];
}

export function loadTemplateRegistry(repoRoot: string): TemplateEntry[] {
  const path = join(repoRoot, "resources", "templates", "registry.json");
  let raw: TemplateRegistryFile;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as TemplateRegistryFile;
  } catch {
    return [];
  }
  const templates = raw.templates ?? [];
  for (const t of templates) {
    if (
      typeof t.id !== "string" ||
      typeof t.entrypoint !== "string" ||
      !["pdflatex", "xelatex", "lualatex"].includes(t.engine) ||
      !["none", "bibtex", "biber", "provided-bbl"].includes(t.bibliography) ||
      !Array.isArray(t.files) ||
      t.files.length === 0 ||
      !t.files.some((f) => f.path === t.entrypoint)
    ) {
      throw new WorkbenchError(
        ERROR_CODES.CONFIG_INVALID,
        `template registry entry ${JSON.stringify(t.id)} is malformed (needs engine/bibliography/entrypoint and a files list containing the entrypoint)`,
      );
    }
    for (const f of t.files) {
      if (!isValidProjectPath(f.path)) {
        throw new WorkbenchError(
          ERROR_CODES.CONFIG_INVALID,
          `template ${t.id} declares invalid project path ${JSON.stringify(f.path)}`,
        );
      }
    }
  }
  return templates;
}

function presetFor(engine: Target["engine"], bibliography: Target["bibliography"]): string {
  if (engine === "xelatex") {
    return bibliography === "bibtex"
      ? "local-tectonic-xelatex-bibtex"
      : "local-tectonic-xelatex";
  }
  return `docker-texlive-${engine}`;
}

export interface InitOutcome {
  snapshot: SnapshotRef;
  target: Target;
  files: string[];
  createdProject: boolean;
}

export function initApprovedProject(options: {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  repoRoot: string;
  templateId: string;
  targetId: string;
}): InitOutcome {
  const { store, blobs, ctx, scope, repoRoot, templateId, targetId } = options;
  requireCapability(ctx, "project.write");

  const template = loadTemplateRegistry(repoRoot).find((t) => t.id === templateId);
  if (template === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `template ${JSON.stringify(templateId)} is not in the approved registry (resources/templates/registry.json)`,
    );
  }

  // Verify every declared file BEFORE any state changes.
  const accepted = template.files.map((f) => {
    const hostPath = realpathSync(join(repoRoot, "resources", "templates", f.resource));
    const bytes = new Uint8Array(readFileSync(hostPath));
    const actual = sha256Hex(bytes);
    if (actual !== f.sha256) {
      throw new WorkbenchError(
        ERROR_CODES.DIGEST_MISMATCH,
        `template ${templateId} file ${f.resource} hashes to ${actual}, registry says ${f.sha256}`,
      );
    }
    return { path: f.path, hostPath, sizeBytes: bytes.length };
  });

  const existing = store.getProject(scope);
  if (existing !== null && existing["head_snapshot_id"] !== null) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `project ${scope.projectId} already has a head snapshot — init is only valid on an empty project`,
    );
  }
  if (existing === null) {
    store.createProject(
      scope,
      canonicalJson(defaultProjectConfig(scope.projectId)),
      utcNowIso(),
      null,
    );
  }

  const snapshot = createSnapshotFromFiles({ store, blobs, scope, files: accepted });
  const target: Target = {
    id: targetId,
    root: template.entrypoint,
    workingDirectory: template.entrypoint.includes("/") ? "entry-parent" : "project-root",
    engine: template.engine,
    bibliography: template.bibliography,
    outputProfileId: template.outputProfileId,
    venueProfileId: null,
    buildPresetId: presetFor(template.engine, template.bibliography),
  };
  store.putTarget(scope, target.id, canonicalJson(target), digestJson(target));

  return {
    snapshot: {
      kind: "snapshot",
      snapshotId: snapshot.snapshotId,
      treeHash: snapshot.treeHash,
      // init only runs on an empty project — the parent is always null.
      parentSnapshotId: null,
      filesCount: snapshot.files.length,
    },
    target,
    files: snapshot.files.map((f) => f.path),
    createdProject: existing === null,
  };
}
