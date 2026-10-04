/**
 * Build artifact collection: walks a job's output directory, admits only
 * regular files inside the root, enforces size limits, validates PDFs
 * structurally, and parses the makefile-rules dependency manifest when the
 * runner produced one. Anything unpublishable is reported, not dropped
 * silently.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  sha256Hex,
  utcNowIso,
  WorkbenchError,
  type ArtifactRef,
} from "@latexwb/contracts";
import type { BlobStore, NewArtifact, Scope, WorkbenchStore } from "@latexwb/storage";
import { isValidProjectPath, toProjectPath } from "./paths.ts";

export interface PdfValidation {
  ok: boolean;
  detail: string;
}

export function validatePdfBytes(bytes: Uint8Array): PdfValidation {
  if (bytes.length === 0) return { ok: false, detail: "empty file" };
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 8));
  if (!head.startsWith("%PDF")) {
    return { ok: false, detail: "missing %PDF header" };
  }
  // Real EOF marker: %%EOF must appear in the last 2 KiB (allowing the
  // usual trailing newline/whitespace after it).
  const tail = new TextDecoder("latin1").decode(bytes.slice(Math.max(0, bytes.length - 2048)));
  const eofIdx = tail.lastIndexOf("%%EOF");
  if (eofIdx === -1) return { ok: false, detail: "missing %%EOF trailer marker" };
  const after = tail.slice(eofIdx + 5);
  if (!/^[\s\r\n]*$/.test(after)) {
    return { ok: false, detail: "trailing garbage after %%EOF" };
  }
  // A startxref/trailer must exist somewhere in the tail region.
  if (!/startxref|trailer/i.test(tail)) {
    return { ok: false, detail: "missing trailer/startxref" };
  }
  return { ok: true, detail: "valid pdf structure" };
}

export interface CollectedArtifact {
  artifactId: string;
  relPath: string;
  kind: ArtifactRef["kind"];
  blobHash: string;
  sizeBytes: number;
  mediaType: string;
  /** Extra fields merged into the artifact row's manifest_json (e.g. the
   * page number of a page-image, or the pdf a render manifest belongs to). */
  manifestExtra?: Record<string, unknown>;
}

export interface RejectedOutput {
  path: string;
  reason: string;
}

const KIND_BY_SUFFIX: Array<[RegExp, ArtifactRef["kind"], string]> = [
  [/\.pdf$/i, "pdf", "application/pdf"],
  [/\.(log|blg)$/i, "log", "text/plain"],
  [/\.(mk|fls|deps)$/i, "manifest", "text/plain"],
  [/\.synctex\.gz$/i, "text", "application/gzip"],
  [/\.(aux|out|toc|nav|snm|vrb|xdv|fdb_latexmk|bbl|bcf|run\.xml)$/i, "text", "text/plain"],
  [/\.(csv|tsv)$/i, "data-table", "text/csv"],
];

function classifyOutput(relPath: string): { kind: ArtifactRef["kind"]; mediaType: string } {
  for (const [re, kind, mediaType] of KIND_BY_SUFFIX) {
    if (re.test(relPath)) return { kind, mediaType };
  }
  return { kind: "text", mediaType: "application/octet-stream" };
}

export interface CollectOptions {
  blobs: BlobStore;
  outputDir: string;
  maxOutputBytes: number;
  jobId: string;
}

export interface CollectResult {
  artifacts: CollectedArtifact[];
  rejected: RejectedOutput[];
  /** Primary PDF artifact when one exists AND validates. */
  pdf: CollectedArtifact | null;
  pdfValidation: PdfValidation | null;
  /** Parsed makefile-rules dependencies, when deps.mk was produced. */
  dependencies: string[] | null;
  depManifestArtifact: CollectedArtifact | null;
  stdout: CollectedArtifact | null;
  stderr: CollectedArtifact | null;
}

/** Parse a GNU-make deps file: `target: dep1 dep2 \\\n cont...`. */
export function parseDepsMk(text: string): string[] {
  const deps = new Set<string>();
  const merged = text.replace(/\\\n/g, " ");
  for (const line of merged.split("\n")) {
    const m = /^[^#][^:]*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    for (const tok of (m[1] as string).split(/\s+/)) {
      const t = tok.trim();
      if (t.length > 0) deps.add(t);
    }
  }
  return [...deps].sort();
}

export function collectArtifacts(options: CollectOptions): CollectResult {
  const { blobs, outputDir, maxOutputBytes, jobId } = options;
  const root = resolve(outputDir);
  const artifacts: CollectedArtifact[] = [];
  const rejected: RejectedOutput[] = [];
  let total = 0;

  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const hostPath = join(dir, entry.name);
      const relPath = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(hostPath, relPath);
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        rejected.push({ path: relPath, reason: "not a regular file" });
        continue;
      }
      const projectPath = toProjectPath(relPath);
      if (!isValidProjectPath(projectPath)) {
        rejected.push({ path: relPath, reason: "invalid path" });
        continue;
      }
      const dest = resolve(root, relPath);
      if (!dest.startsWith(root + sep) && dest !== root) {
        rejected.push({ path: relPath, reason: "path escapes output root" });
        continue;
      }
      const stat = statSync(hostPath);
      total += stat.size;
      if (total > maxOutputBytes) {
        rejected.push({ path: relPath, reason: `cumulative output exceeds ${maxOutputBytes}` });
        continue;
      }
      const bytes = readFileSync(hostPath);
      const blob = blobs.put(bytes);
      const { kind, mediaType } = classifyOutput(relPath);
      artifacts.push({
        artifactId: `${kind}-${blob.hash.slice(0, 16)}`,
        relPath: projectPath,
        kind,
        blobHash: blob.hash,
        sizeBytes: bytes.length,
        mediaType,
      });
    }
  };
  walk(root, "");

  let pdf: CollectedArtifact | null = null;
  let pdfValidation: PdfValidation | null = null;
  const pdfCandidate = artifacts.find((a) => a.kind === "pdf");
  if (pdfCandidate !== undefined) {
    pdfValidation = validatePdfBytes(blobs.getVerified(pdfCandidate.blobHash));
    if (pdfValidation.ok) {
      pdf = pdfCandidate;
    }
  }

  let dependencies: string[] | null = null;
  let depManifestArtifact: CollectedArtifact | null = null;
  const depsFile = artifacts.find((a) => a.relPath === "deps.mk" || a.relPath.endsWith(".fls"));
  if (depsFile !== undefined) {
    const text = new TextDecoder("utf8", { fatal: false }).decode(
      blobs.getVerified(depsFile.blobHash),
    );
    if (depsFile.relPath === "deps.mk") {
      dependencies = parseDepsMk(text);
    } else {
      dependencies = parseFls(text);
    }
    depManifestArtifact = depsFile;
  }

  return {
    artifacts,
    rejected,
    pdf,
    pdfValidation,
    dependencies,
    depManifestArtifact,
    stdout: null,
    stderr: null,
  };
}

/** Parse a kpsewhich recorder (.fls) file's INPUT lines. */
export function parseFls(text: string): string[] {
  const deps = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^INPUT\s+(.+)$/.exec(line.trim());
    if (m !== null) deps.add((m[1] as string).trim());
  }
  return [...deps].sort();
}

/** Persist collected artifacts as artifact rows (call inside a tx). */
export function insertArtifactRows(options: {
  store: WorkbenchStore;
  scope: Scope;
  snapshotId: string;
  targetId: string | null;
  jobId: string;
  artifacts: CollectedArtifact[];
  createdAt?: string;
}): void {
  const { store, scope, snapshotId, targetId, jobId, artifacts } = options;
  const createdAt = options.createdAt ?? utcNowIso();
  for (const a of artifacts) {
    // Idempotent on artifactId: a cache-hit rebuild reuses rows, never
    // duplicates them (createdAt of the original is preserved).
    if (store.getArtifact(scope, a.artifactId) !== null) continue;
    const row: NewArtifact = {
      artifactId: a.artifactId,
      snapshotId,
      targetId,
      jobId,
      kind: a.kind,
      blobHash: a.blobHash,
      sizeBytes: a.sizeBytes,
      mediaType: a.mediaType,
      manifestJson: canonicalJson({ path: a.relPath, jobId, ...(a.manifestExtra ?? {}) }),
      createdAt,
    };
    store.insertArtifact(scope, row);
  }
}

export function artifactRefOf(
  scope: Scope,
  snapshotId: string,
  targetId: string | null,
  jobId: string,
  a: CollectedArtifact,
  createdAt: string,
): ArtifactRef {
  return {
    id: a.artifactId,
    projectId: scope.projectId,
    snapshotId,
    targetId,
    jobId,
    kind: a.kind,
    sha256: a.blobHash,
    bytes: a.sizeBytes,
    mediaType: a.mediaType,
    createdAt,
  };
}

export function requireArtifact(store: WorkbenchStore, scope: Scope, artifactId: string) {
  const row = store.getArtifact(scope, artifactId);
  if (row === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `artifact ${artifactId} not found`);
  }
  return row;
}
