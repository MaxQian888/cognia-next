/**
 * latex_project — project lifecycle and source access.
 * Live: inspect, snapshot, read, search, artifact-read, doctor,
 *       init (M3 — approved, digest-verified host templates only), and
 *       resource (M3 — approved registry entries verified by sha256).
 *
 * Reads are snapshot-scoped: `path`/`pathPrefix` are snapshot-relative and
 * the frozen ProjectInput schema already rejects absolute paths, `..`,
 * drive letters and backslashes before this code runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ERROR_CODES,
  WorkbenchError,
  type ArtifactReadResult,
  type HostPolicy,
  type ProjectInput,
  type SourceReadResult,
  type SourceSearchResult,
  type Target,
} from "@latexwb/contracts";
import {
  createSnapshotFromFiles,
  getApprovedResource,
  initApprovedProject,
  inspectDerived,
  limitsFromHostPolicy,
  readSnapshotFile,
  scanImportDirectory,
  snapshotFileRows,
} from "@latexwb/core";
import { buildDoctorReportFull } from "@latexwb/runtime";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { ProjectParams } from "../schemas.ts";
import { runTool, toAgentResult, type DispatchOutcome } from "./common.ts";

const MAX_SEARCH_MATCHES = 200;

function headOrThrow(session: WorkbenchSession, scope: Scope): string {
  const head = session.headSnapshotId(scope);
  if (head === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `project ${scope.projectId} has no head snapshot`,
    );
  }
  return head;
}

function requireSnapshotRow(session: WorkbenchSession, scope: Scope, snapshotId: string): void {
  if (session.store.getSnapshot(scope, snapshotId) === null) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `snapshot ${snapshotId} not found in project ${scope.projectId}`,
    );
  }
}

function sliceLines(text: string, startLine: number | undefined, maxLines: number | undefined) {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const start = startLine ?? 1;
  const count = Math.min(maxLines ?? 200, 1000);
  if (start < 1 || (totalLines > 0 && start > totalLines)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `startLine ${start} is outside the file's ${totalLines} lines`,
    );
  }
  const end = Math.min(start + count - 1, totalLines);
  const slice = lines.slice(start - 1, end);
  // Byte offset of each returned line's start within the decoded text —
  // patch edit ops take byte ranges, so the model needs these to address
  // edits without hand-counting UTF-8.
  let cursor = 0;
  for (let i = 0; i < start - 1; i++) {
    cursor += Buffer.byteLength(lines[i] as string, "utf8") + 1;
  }
  const lineByteOffsets: number[] = [];
  for (const line of slice) {
    lineByteOffsets.push(cursor);
    cursor += Buffer.byteLength(line, "utf8") + 1;
  }
  return {
    startLine: start,
    endLine: end,
    totalLines,
    text: slice.join("\n"),
    lineByteOffsets,
    nextStartLine: end < totalLines ? end + 1 : null,
    truncated: end < totalLines,
  };
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `${what} is not UTF-8 text; binary content cannot be returned as text`,
    );
  }
}

function loadHostPolicy(repoRoot: string): HostPolicy | null {
  try {
    return JSON.parse(
      readFileSync(join(repoRoot, "runtime/host-policy.json"), "utf8"),
    ) as HostPolicy;
  } catch {
    return null;
  }
}

async function dispatch(
  session: WorkbenchSession,
  input: ProjectInput,
  scope: Scope,
): Promise<DispatchOutcome> {
  const { store, blobs } = session;
  switch (input.action) {
    case "inspect": {
      const snapshotId = headOrThrow(session, scope);
      const existingTargets = store
        .listTargets(scope)
        .map((r) => JSON.parse(r["config_json"] as string) as Target);
      if (
        input.targetId !== undefined &&
        !existingTargets.some((t) => t.id === input.targetId)
      ) {
        throw new WorkbenchError(
          ERROR_CODES.NOT_FOUND,
          `target ${input.targetId} not found in project ${scope.projectId}`,
        );
      }
      const { inspection } = inspectDerived({
        store,
        blobs,
        scope,
        snapshotId,
        projectId: scope.projectId,
        existingTargets,
      });
      return { data: inspection, snapshotId };
    }
    case "init": {
      const out = initApprovedProject({
        store,
        blobs,
        ctx: session.requestContextFor(["project.write", "project.read"]),
        scope,
        repoRoot: session.config.repoRoot,
        templateId: input.templateId,
        targetId: input.targetId,
      });
      return {
        data: out.snapshot,
        snapshotId: out.snapshot.snapshotId,
        diagnostics: [{
          code: "INIT_OK",
          severity: "info",
          message:
            `initialized from approved template "${input.templateId}" ` +
            `(${String(out.files.length)} files: ${out.files.join(", ")}) ` +
            `with target "${out.target.id}" (${out.target.engine}/${out.target.bibliography})` +
            (out.createdProject ? "; created the project row" : ""),
          source: null,
          page: null,
          causeId: null,
          evidenceArtifactIds: [],
          rawLogRange: null,
          confidence: "certain",
        }],
      };
    }
    case "snapshot": {
      const head = headOrThrow(session, scope);
      if (input.expectedHeadSnapshotId !== head) {
        throw new WorkbenchError(
          ERROR_CODES.STALE_BASE,
          `expected head ${input.expectedHeadSnapshotId} but current head is ${head}`,
        );
      }
      const hostRoot = session.hostRoot(scope);
      if (hostRoot === null) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `project ${scope.projectId} has no registered host root; cannot re-snapshot`,
        );
      }
      const scan = scanImportDirectory(
        hostRoot,
        limitsFromHostPolicy(loadHostPolicy(session.config.repoRoot)),
      );
      if (scan.accepted.length === 0) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `re-snapshot of the registered host root accepted zero files`,
        );
      }
      const snap = createSnapshotFromFiles({ store, blobs, scope, files: scan.accepted });
      return {
        data: {
          kind: "snapshot",
          snapshotId: snap.snapshotId,
          treeHash: snap.treeHash,
          parentSnapshotId: head,
          filesCount: snap.files.length,
        },
        snapshotId: snap.snapshotId,
      };
    }
    case "read": {
      const snapshotId = input.snapshotId;
      requireSnapshotRow(session, scope, snapshotId);
      const bytes = readSnapshotFile({ store, blobs, scope, snapshotId, path: input.path });
      if (bytes === null) {
        throw new WorkbenchError(
          ERROR_CODES.NOT_FOUND,
          `path ${JSON.stringify(input.path)} is not in snapshot ${snapshotId}`,
        );
      }
      const row = snapshotFileRows(store, scope, snapshotId).find(
        (r) => r["path"] === input.path,
      );
      const text = decodeUtf8(bytes, `file ${input.path}`);
      const data: SourceReadResult = {
        kind: "source-read",
        snapshotId,
        path: input.path,
        sha256: (row?.["blob_hash"] as string | undefined) ?? "",
        ...sliceLines(text, input.startLine, input.maxLines),
      };
      return { data, snapshotId };
    }
    case "search": {
      const snapshotId = input.snapshotId;
      requireSnapshotRow(session, scope, snapshotId);
      const cap = Math.min(input.maxResults ?? 30, MAX_SEARCH_MATCHES);
      const matches: SourceSearchResult["matches"] = [];
      let truncated = false;
      outer: for (const row of snapshotFileRows(store, scope, snapshotId)) {
        const path = row["path"] as string;
        if (input.pathPrefix !== undefined && !path.startsWith(input.pathPrefix)) continue;
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            blobs.getVerified(row["blob_hash"] as string),
          );
        } catch {
          continue; // binary files are not searchable text
        }
        let byteCursor = 0;
        for (const [i, line] of text.split("\n").entries()) {
          if (line.includes(input.query)) {
            matches.push({
              path,
              sha256: row["blob_hash"] as string,
              line: i + 1,
              byteOffset: byteCursor,
              text: line,
            });
            if (matches.length >= cap) {
              truncated = true;
              break outer;
            }
          }
          byteCursor += Buffer.byteLength(line, "utf8") + 1;
        }
      }
      const data: SourceSearchResult = {
        kind: "source-search",
        snapshotId,
        matches,
        truncated,
      };
      return { data, snapshotId };
    }
    case "artifact-read": {
      const row = store.getArtifact(scope, input.artifactId);
      // Patch diffs are CAS blobs (id = "diff-" + blob hash) emitted by
      // latex_patch propose without an artifacts row — proposals are not
      // jobs, and the artifacts table requires one. Resolve them straight
      // from CAS so the model can inspect a proposed diff before apply.
      const casHash = row === null && /^diff-[a-f0-9]{64}$/.test(input.artifactId)
        ? input.artifactId.slice(5)
        : null;
      if (row === null && casHash === null) {
        throw new WorkbenchError(
          ERROR_CODES.NOT_FOUND,
          `artifact ${input.artifactId} not found`,
        );
      }
      const blobHash = (row?.["blob_hash"] as string | undefined) ?? (casHash as string);
      const text = decodeUtf8(
        blobs.getVerified(blobHash),
        `artifact ${input.artifactId}`,
      );
      const data: ArtifactReadResult = {
        kind: "artifact-read",
        artifactId: input.artifactId,
        sha256: blobHash,
        ...sliceLines(text, input.startLine, input.maxLines),
      };
      return { data, snapshotId: session.headSnapshotId(scope) };
    }
    case "resource": {
      const resource = getApprovedResource({
        ctx: session.requestContextFor(["skill.resource.read"]),
        repoRoot: session.config.repoRoot,
        resourceId: input.resourceId,
      });
      return { data: resource, snapshotId: (store.getProject(scope)?.["head_snapshot_id"] as string | null) ?? null };
    }
    case "doctor": {
      const report = await buildDoctorReportFull({
        repoRoot: session.config.repoRoot,
        hostPolicyPath: join(session.config.repoRoot, "runtime/host-policy.json"),
        toolchainLockPath: join(session.config.repoRoot, "runtime/toolchain-lock.json"),
      });
      return { data: report, snapshotId: (store.getProject(scope)?.["head_snapshot_id"] as string | null) ?? null };
    }
  }
}

export function projectTool(session: WorkbenchSession): ToolDefinition {
  return {
    name: "latex_project",
    label: "LaTeX Project",
    description:
      "Inspect, re-snapshot, read, and search the bound LaTeX project; read " +
      "build artifacts and run the environment doctor. Paths are " +
      "snapshot-relative only — host paths and URLs are rejected. " +
      "read/artifact-read return lineByteOffsets and search matches carry " +
      "byteOffset — use them as startByte/endByte for latex_patch edits. " +
      "Load skills with resourceId 'skill:<name>' or 'skill:<name>:guide'. " +
      "init creates an empty project from an approved template. " +
      "snapshot RE-IMPORTS the host directory; it is not a save action. " +
      "Use inspect to continue editing the latest applied snapshot.",
    promptSnippet: "Inspect and read the current LaTeX snapshot; load approved skills and templates",
    parameters: ProjectParams,
    async execute(_toolCallId, params) {
      const envelope = await runTool(session, "ProjectInput", params, (input: ProjectInput, scope) =>
        dispatch(session, input, scope),
      );
      return toAgentResult(envelope);
    },
  };
}
