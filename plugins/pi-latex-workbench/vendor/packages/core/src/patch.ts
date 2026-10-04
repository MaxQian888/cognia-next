/**
 * Two-phase patch lifecycle (M2, API_CONTRACT §2.2 / SPEC §5.2).
 *
 * propose: validates every FileOperation semantically (beyond JSON Schema —
 * UTF-8 boundaries, overlap, expectedSha256, path rules, limits), applies
 * ops to an in-memory copy of the base snapshot, runs protected-content
 * analysis, stores a real unified diff in CAS, and persists the patch row.
 * Nothing touches head.
 *
 * apply: re-verifies head == baseSnapshotId (STALE_BASE with current head +
 * conflicting paths), re-verifies expectedSha256 per file, requires host
 * approval from the *context* when the proposal was review-required, then
 * commits candidate snapshot + head CAS + patch state + event in ONE
 * transaction. Idempotent replay returns the stored result — edits are
 * never applied twice.
 *
 * revert: builds the inverse operations and submits them through the SAME
 * propose path — a revert is a new patch that still needs review/apply.
 */
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  utcNowIso,
  WorkbenchError,
  type FileOperation,
  type PatchApplicationResult,
  type PatchProposal,
  type ProtectedChange,
  type SnapshotFile,
  type SnapshotManifest,
} from "@latexwb/contracts";
import { inTransaction, type BlobStore, type Row, type Scope, type WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import {
  analyzeProtectedChanges,
  collectProjectMacros,
  collectProjectUsedMacros,
  isAdditiveChange,
  type ByteRange,
} from "./protect.ts";
import { grantApproval } from "./approvals.ts";
import { classifyRole } from "./import.ts";
import { isValidProjectPath } from "./paths.ts";

export const PATCH_LIMITS = {
  maxFiles: 50,
  maxEdits: 200,
  maxTextBytes: 512 * 1024,
} as const;

const APPROVABLE_ACTION = "patch.apply";

interface BaseFile {
  path: string;
  sha256: string;
  bytes: number;
  role: string;
  content: Uint8Array;
}

interface Options {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
}

// ---------------------------------------------------------------------------
// unified diff (line-based LCS — real diff output, deterministic)
// ---------------------------------------------------------------------------

function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // LCS table
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => dp[i * (m + 1) + j] as number;
  const set = (i: number, j: number, v: number): void => {
    dp[i * (m + 1) + j] = v;
  };
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      set(i, j, a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1)));
    }
  }
  // backtrack into ops
  type Op = { kind: "keep" | "del" | "ins"; a?: string | undefined; b?: string | undefined };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "keep", a: a[i] });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "del", a: a[i] });
      i += 1;
    } else {
      ops.push({ kind: "ins", b: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", a: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "ins", b: b[j] });
    j += 1;
  }
  // group into hunks with context
  const changedIdx = ops.map((o, idx) => (o.kind === "keep" ? -1 : idx)).filter((x) => x >= 0);
  if (changedIdx.length === 0) return "";
  const hunks: { start: number; end: number }[] = [];
  let hs = Math.max(0, (changedIdx[0] as number) - context);
  let he = Math.min(ops.length, (changedIdx[0] as number) + context + 1);
  for (const c of changedIdx.slice(1)) {
    if (c - context <= he) {
      he = Math.min(ops.length, c + context + 1);
    } else {
      hunks.push({ start: hs, end: he });
      hs = Math.max(0, c - context);
      he = Math.min(ops.length, c + context + 1);
    }
  }
  hunks.push({ start: hs, end: he });

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    let aStart = 0;
    let bStart = 0;
    let aCount = 0;
    let bCount = 0;
    for (let k = 0; k < h.end; k += 1) {
      const o = ops[k] as Op;
      if (k < h.start) {
        if (o.kind !== "ins") aStart += 1;
        if (o.kind !== "del") bStart += 1;
      } else {
        if (o.kind !== "ins") aCount += 1;
        if (o.kind !== "del") bCount += 1;
      }
    }
    lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (let k = h.start; k < h.end; k += 1) {
      const o = ops[k] as Op;
      if (o.kind === "keep") lines.push(` ${o.a}`);
      else if (o.kind === "del") lines.push(`-${o.a}`);
      else lines.push(`+${o.b}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function utf8Boundary(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset > bytes.length) return false;
  if (offset === 0 || offset === bytes.length) return true;
  // A continuation byte is 10xxxxxx; a boundary offset must not land inside
  // a multi-byte sequence — check the byte before is not mid-sequence.
  const b = bytes[offset] as number;
  return (b & 0xc0) !== 0x80;
}

function loadBaseFiles(store: WorkbenchStore, blobs: BlobStore, scope: Scope, snapshotId: string): Map<string, BaseFile> {
  const rows = store.listSnapshotFiles(scope, snapshotId);
  const files = new Map<string, BaseFile>();
  for (const r of rows) {
    const path = r["path"] as string;
    const sha = r["blob_hash"] as string;
    files.set(path, {
      path,
      sha256: sha,
      bytes: r["size_bytes"] as number,
      role: r["role"] as string,
      content: blobs.getVerified(sha),
    });
  }
  return files;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// text-anchored replace → byte-range edit (ADR-0007)
// ---------------------------------------------------------------------------

/** 1-based line number of a UTF-16 index. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

function allIndexes(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Resolve every `replace` operation against the BASE snapshot into the
 * equivalent byte-range `edit` operation (with the base file's sha256), so
 * the digest, protected-content analysis, stored operations and apply path
 * are exactly those of a hand-computed edit. Exact-text anchors remove the
 * failure mode where a model miscounts UTF-8 byte offsets (a live run
 * produced "arere" from a 2-byte slip). Ambiguity is never guessed: an
 * `oldText` must match exactly once unless `occurrence` picks one.
 */
function resolveReplaceOperations(
  operations: FileOperation[],
  base: Map<string, BaseFile>,
): FileOperation[] {
  return operations.map((op) => {
    if (op.op !== "replace") return op;
    const p = op.path.normalize("NFC");
    const file = base.get(p);
    if (file === undefined) {
      throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `replace target ${p} does not exist in base snapshot`);
    }
    if (op.expectedSha256 !== undefined && op.expectedSha256 !== file.sha256) {
      throw new WorkbenchError(ERROR_CODES.STALE_BASE, `replace expectedSha256 for ${p} does not match base content`);
    }
    const text = decodeText(file.content);
    if (text === null) {
      throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `replace target ${p} is not UTF-8 text`);
    }
    const edits = op.edits.map((edit, n) => {
      const where = `replace edit #${n + 1} on ${p}`;
      const hits = allIndexes(text, edit.oldText);
      if (hits.length === 0) {
        const squash = (s: string) => s.replace(/\s+/g, " ").trim();
        const loose = squash(text).includes(squash(edit.oldText));
        const crlf = text.includes("\r\n") && !edit.oldText.includes("\r\n") && edit.oldText.includes("\n");
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `${where}: oldText not found in the base snapshot` +
            (crlf ? " (the file uses CRLF line endings)" : "") +
            (loose ? " — a whitespace-insensitive match exists; re-read the file and copy the exact text including line breaks" : " — re-read the current source; it may have changed or the text was paraphrased"),
        );
      }
      let index: number;
      if (edit.occurrence !== undefined) {
        if (edit.occurrence > hits.length) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `${where}: occurrence ${edit.occurrence} requested but oldText occurs ${hits.length} time(s)`,
          );
        }
        index = hits[edit.occurrence - 1] as number;
      } else if (hits.length > 1) {
        const lines = hits.slice(0, 10).map((i) => lineOf(text, i));
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `${where}: oldText is ambiguous — it occurs ${hits.length} times (lines ${lines.join(", ")}${hits.length > 10 ? ", …" : ""}); ` +
            "include more surrounding text to make it unique, or set occurrence (1-based)",
        );
      } else {
        index = hits[0] as number;
      }
      const startByte = utf8Bytes(text.slice(0, index)).length;
      return {
        startByte,
        endByte: startByte + utf8Bytes(edit.oldText).length,
        replacement: edit.newText,
      };
    });
    return { op: "edit", path: op.path, expectedSha256: file.sha256, edits };
  });
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export function proposePatch(
  opts: Options & {
    baseSnapshotId: string;
    operations: FileOperation[];
    reason: string;
    citekeyMapping?: Record<string, string> | undefined;
    /**
     * sha256 of approved-template files (resources/templates/registry.json).
     * A base file whose bytes are still exactly a template file is
     * scaffolding, not user content: its sample equations/labels were never
     * authored or approved by anyone, so replacing it is analysed as writing
     * a new file (every protected item in the result counts as added).
     */
    scaffoldSha256s?: ReadonlySet<string> | undefined;
  },
): PatchProposal {
  const { store, blobs, ctx, scope, baseSnapshotId, reason } = opts;
  requireCapability(ctx, "project.write");

  if (opts.operations.length === 0) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, "patch must contain at least one operation");
  }
  if (opts.operations.length > PATCH_LIMITS.maxFiles) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `patch touches ${opts.operations.length} files; limit is ${PATCH_LIMITS.maxFiles}`,
    );
  }

  const base = loadBaseFiles(store, blobs, scope, baseSnapshotId);
  if (base.size === 0) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `snapshot ${baseSnapshotId} has no files or does not exist`);
  }
  // Text-anchored replacements become concrete byte edits before anything
  // else — the proposal, digest and approval bind to exact bytes.
  const operations = resolveReplaceOperations(opts.operations, base);

  // Path hygiene + duplicate detection (NFC + case-insensitive).
  const seen = new Map<string, string>();
  for (const op of operations) {
    const p = (op as { path: string }).path.normalize("NFC");
    if (!isValidProjectPath(p)) {
      throw new WorkbenchError(ERROR_CODES.UNSUPPORTED_PATH, `invalid project path ${JSON.stringify(p)}`);
    }
    const key = p.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `path ${JSON.stringify(p)} is targeted by more than one operation (collides with ${prior})`,
      );
    }
    seen.set(key, p);
  }

  // Apply ops to an in-memory copy; collect semantic failures early.
  // Ranges are tracked per side: rangesBefore are byte offsets into the base
  // content, rangesAfter into the post-edit content (edits shift bytes).
  const newContents = new Map<string, Uint8Array>();
  for (const [p, f] of base) newContents.set(p, f.content);
  const rangesBefore = new Map<string, ByteRange[]>();
  const rangesAfter = new Map<string, ByteRange[]>();
  const pushRanges = (p: string, b: ByteRange[], a: ByteRange[]): void => {
    rangesBefore.set(p, b);
    rangesAfter.set(p, a);
  };
  let totalEdits = 0;
  let totalTextBytes = 0;

  for (const op of operations) {
    const p = (op as { path: string }).path.normalize("NFC");
    switch (op.op) {
      case "attach-asset": {
        const artifact = store.getArtifact(scope, op.artifactId);
        if (artifact === null) {
          throw new WorkbenchError(
            ERROR_CODES.NOT_FOUND,
            `attach-asset artifact ${op.artifactId} is not registered in this project`,
          );
        }
        const kind = artifact["kind"] as string;
        if (!["asset", "image", "text", "data", "manifest"].includes(kind)) {
          throw new WorkbenchError(
            ERROR_CODES.POLICY_DENIED,
            `artifact ${op.artifactId} has kind '${kind}'; attach-asset only accepts registered asset-type artifacts`,
          );
        }
        const existing = base.get(p);
        if (existing === undefined) {
          if (op.expectedSha256 !== null) {
            throw new WorkbenchError(
              ERROR_CODES.STALE_BASE,
              `attach-asset expectedSha256 given for ${p}, but the path does not exist in base`,
            );
          }
        } else {
          // Path exists: null expectedSha256 would silently clobber — refuse.
          if (op.expectedSha256 === null) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `attach-asset on existing path ${p} requires expectedSha256 (null means 'must be a new file')`,
            );
          }
          if (existing.sha256 !== op.expectedSha256) {
            throw new WorkbenchError(
              ERROR_CODES.STALE_BASE,
              `attach-asset expectedSha256 does not match current content of ${p}`,
            );
          }
        }
        const blob = blobs.getVerified(artifact["blob_hash"] as string);
        newContents.set(p, blob);
        pushRanges(
          p,
          existing === undefined ? [] : [{ startByte: 0, endByte: existing.bytes }],
          [{ startByte: 0, endByte: blob.length }],
        );
        break;
      }
      case "edit": {
        const existing = base.get(p);
        if (existing === undefined) {
          throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `edit target ${p} does not exist in base snapshot`);
        }
        if (existing.sha256 !== op.expectedSha256) {
          throw new WorkbenchError(
            ERROR_CODES.STALE_BASE,
            `edit expectedSha256 for ${p} does not match base content`,
          );
        }
        const len = existing.content.length;
        const sorted = [...op.edits].sort((a, b) => a.startByte - b.startByte);
        let prevEnd = -1;
        for (const e of sorted) {
          totalEdits += 1;
          totalTextBytes += utf8Bytes(e.replacement).length;
          if (e.endByte < e.startByte) {
            throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `edit on ${p} has endByte < startByte`);
          }
          if (e.startByte < prevEnd) {
            throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `edits on ${p} overlap`);
          }
          if (!utf8Boundary(existing.content, e.startByte) || !utf8Boundary(existing.content, e.endByte)) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `edit on ${p} has an offset that is not a UTF-8 character boundary`,
            );
          }
          prevEnd = e.endByte;
        }
        // Apply edits to bytes, tracking after-side coordinates as the
        // cumulative length delta shifts later ranges.
        const out: number[] = [];
        let cursor = 0;
        let delta = 0;
        const bRanges: ByteRange[] = [];
        const aRanges: ByteRange[] = [];
        for (const e of sorted) {
          for (let k = cursor; k < e.startByte; k += 1) out.push(existing.content[k] as number);
          const replBytes = utf8Bytes(e.replacement);
          for (const byte of replBytes) out.push(byte);
          cursor = e.endByte;
          bRanges.push({ startByte: e.startByte, endByte: e.endByte });
          aRanges.push({ startByte: e.startByte + delta, endByte: e.startByte + delta + replBytes.length });
          delta += replBytes.length - (e.endByte - e.startByte);
        }
        for (let k = cursor; k < len; k += 1) out.push(existing.content[k] as number);
        newContents.set(p, new Uint8Array(out));
        pushRanges(p, bRanges, aRanges);
        break;
      }
      case "create": {
        if (base.has(p)) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `create target ${p} already exists in base snapshot`);
        }
        // NFC/case conflict against existing files.
        for (const existingPath of base.keys()) {
          if (existingPath.toLowerCase() === p.toLowerCase()) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `create path ${p} collides with existing ${existingPath} under case-insensitive comparison`,
            );
          }
        }
        const bytes = utf8Bytes(op.content);
        if (bytes.length > PATCH_LIMITS.maxTextBytes) {
          throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `create content for ${p} exceeds text limit`);
        }
        totalTextBytes += bytes.length;
        newContents.set(p, bytes);
        pushRanges(p, [], [{ startByte: 0, endByte: bytes.length }]);
        break;
      }
      case "delete": {
        const existing = base.get(p);
        if (existing === undefined) {
          throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `delete target ${p} does not exist in base snapshot`);
        }
        if (existing.sha256 !== op.expectedSha256) {
          throw new WorkbenchError(
            ERROR_CODES.STALE_BASE,
            `delete expectedSha256 for ${p} does not match base content`,
          );
        }
        newContents.delete(p);
        pushRanges(p, [{ startByte: 0, endByte: existing.bytes }], []);
        break;
      }
      case "replace":
        // resolveReplaceOperations() has already turned these into edits.
        throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `internal: unresolved replace operation on ${p}`);
    }
  }
  if (totalEdits > PATCH_LIMITS.maxEdits) {
    throw new WorkbenchError(ERROR_CODES.INVALID_REQUEST, `patch has ${totalEdits} edits; limit ${PATCH_LIMITS.maxEdits}`);
  }
  if (totalTextBytes > PATCH_LIMITS.maxTextBytes) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `patch writes ${totalTextBytes} text bytes; limit ${PATCH_LIMITS.maxTextBytes}`,
    );
  }

  // ---- protected-content analysis -----------------------------------------
  const baseTexts = [...base.values()].map((f) => decodeText(f.content) ?? "");
  const projectMacros = collectProjectMacros(baseTexts);
  const projectUsedMacros = collectProjectUsedMacros(baseTexts);
  const protectedChanges: ProtectedChange[] = [];
  const changedPaths: string[] = [];
  for (const p of rangesAfter.keys()) {
    changedPaths.push(p);
    const beforeF = base.get(p);
    const afterB = newContents.get(p) ?? null;
    // "File absent" (create/delete) is not the same as "file exists but is
    // not UTF-8": an absent side contributes empty text so added/removed
    // math regions are still detected; only a genuinely undecodable side
    // triggers the needs-review flag below.
    const beforeMissing = beforeF === undefined;
    const afterMissing = afterB === null;
    const beforeText = beforeMissing ? "" : decodeText(beforeF.content);
    const afterText = afterMissing ? "" : decodeText(afterB);
    if (beforeText === null || afterText === null) {
      // At least one side is not valid UTF-8 — token analysis cannot run.
      // Role protection still fires (template/raw-asset are byte-compared);
      // anything else reports the hashes so review sees a real change.
      const role = beforeF?.role ?? classifyRole(p);
      if (role === "template" || role === "raw-asset") {
        protectedChanges.push({
          path: p,
          category: role === "template" ? "template" : "raw-asset",
          before: beforeF?.sha256 ?? "",
          after: afterB === null ? "" : sha256Hex(afterB),
          reason: `protected binary ${role} file changed`,
        });
      } else {
        protectedChanges.push({
          path: p,
          category: "unknown-macro",
          before: beforeF?.sha256 ?? "",
          after: afterB === null ? "" : sha256Hex(afterB),
          reason: "file content is not valid UTF-8 on at least one side; token-level protected analysis could not run — needs review",
        });
      }
      continue;
    }
    const scaffold = beforeF !== undefined && !afterMissing && opts.scaffoldSha256s?.has(beforeF.sha256) === true;
    protectedChanges.push(
      ...analyzeProtectedChanges({
        path: p,
        role: beforeF?.role ?? classifyRole(p),
        before: beforeMissing || scaffold ? null : beforeText,
        after: afterMissing ? null : afterText,
        rangesBefore: scaffold ? [] : rangesBefore.get(p) ?? [],
        rangesAfter: scaffold ? [{ startByte: 0, endByte: utf8Bytes(afterText).length }] : rangesAfter.get(p) ?? [],
        projectDefinedMacros: projectMacros,
        projectUsedMacros,
        citekeyMapping: opts.citekeyMapping,
      }),
    );
  }
  changedPaths.sort();

  // Unmapped citation-key removals are a hard refusal, not a review item.
  const unmappedCite = protectedChanges.find(
    (c) => c.category === "citation-key" && c.reason.includes("without an explicit mapping"),
  );
  if (unmappedCite !== undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `patch rejected: ${unmappedCite.reason}`,
    );
  }

  const risk = protectedChanges.length > 0 ? "review-required" : "normal";

  // ---- diff artifact -------------------------------------------------------
  const diffParts: string[] = [];
  for (const p of changedPaths) {
    const beforeB = base.get(p)?.content;
    const afterB = newContents.get(p);
    const beforeText = beforeB === undefined ? "" : decodeText(beforeB);
    const afterText = afterB === undefined ? "" : decodeText(afterB);
    if (beforeText === null || afterText === null) {
      diffParts.push(`Binary files a/${p} and b/${p} differ\n`);
    } else {
      diffParts.push(unifiedDiff(p, beforeText, afterText));
    }
  }
  const diffBytes = utf8Bytes(diffParts.join(""));
  const diffHash = blobs.put(diffBytes).hash;
  const diffArtifactId = `diff-${diffHash}`;

  // ---- persist proposal -----------------------------------------------------
  const patchId = `patch-${randomUUID()}`;
  const digest = sha256Hex(
    utf8Bytes(
      canonicalJson({
        baseSnapshotId,
        operations,
        reason,
        diff: diffHash,
      }),
    ),
  );
  const createdAt = utcNowIso();
  store.insertPatch(scope, {
    patchId,
    baseSnapshotId,
    patchDigest: digest,
    operationsJson: canonicalJson({ reason, operations, diffArtifactId }),
    protectedChangesJson: canonicalJson(protectedChanges),
    state: risk === "review-required" ? "waiting-approval" : "proposed",
    createdAt,
  });

  if (risk === "review-required") {
    inTransaction(store.db, () => {
      store.emitProjectEventInTx(scope, {
        jobId: null,
        createdAt,
        eventJson: (seq) =>
          canonicalJson({
            schemaVersion: 1,
            seq,
            projectId: scope.projectId,
            jobId: null,
            snapshotId: baseSnapshotId,
            attempt: null,
            fencingToken: null,
            type: "review.required",
            timestamp: createdAt,
            payload: {
              artifactId: diffArtifactId,
              // The schema's review.required payload has no reason field —
              // the categories ARE the explanation; the diff artifact and
              // the patch row carry the full detail.
              checkIds: [
                "patch.protected-content",
                ...new Set(protectedChanges.map((c) => `protected.${c.category}`)),
              ],
              pages: [],
            },
          }),
      });
    });
  }

  return {
    kind: "patch-proposal",
    patchId,
    baseSnapshotId,
    digest,
    changedPaths,
    diffArtifactId,
    protectedChanges,
    risk: risk as PatchProposal["risk"],
    requiredApprovals: risk === "review-required" ? [APPROVABLE_ACTION] : [],
  };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Host protection mode for apply (ADR-0007). `strict` (default): every
 * protected change needs a per-patch host grant. `authoring`: the host has
 * pre-authorized NEW protected content (new equations, labels, citations,
 * numeric anchors, literal blocks, commands) — a patch whose protected
 * changes are all additions applies with an auto-recorded, patch-bound
 * approval attributed to the host principal; any modification or removal
 * of existing protected content still needs an explicit grant.
 */
export type ProtectionMode = "strict" | "authoring";

export interface PatchApplyOutcome extends PatchApplicationResult {
  /** How the protected-content gate was satisfied, when it applied. */
  authorization: "not-required" | "host-grant" | "authoring-mode";
  approvalId: string | null;
}

export function applyPatch(
  opts: Options & { patchId: string; protectionMode?: ProtectionMode },
): PatchApplyOutcome {
  const { store, blobs, ctx, scope, patchId } = opts;
  requireCapability(ctx, "project.write");

  const patch = store.getPatch(scope, patchId);
  if (patch === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `patch ${patchId} not found`);
  }
  const baseSnapshotId = patch["base_snapshot_id"] as string;

  // Idempotent replay: an already-applied patch returns its recorded result.
  if ((patch["state"] as string) === "applied") {
    const resultSnapshotId = patch["result_snapshot_id"] as string;
    const snap = store.getSnapshot(scope, resultSnapshotId);
    return {
      kind: "patch-applied",
      patchId,
      previousSnapshotId: baseSnapshotId,
      snapshotId: resultSnapshotId,
      treeHash: (snap?.["tree_hash"] as string) ?? "",
      materialization: "not-requested",
      authorization: "not-required",
      approvalId: null,
    };
  }
  if (!["proposed", "waiting-approval"].includes(patch["state"] as string)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `patch ${patchId} is in state '${patch["state"]}' and cannot be applied`,
    );
  }

  const project = store.getProject(scope);
  const head = (project?.["head_snapshot_id"] as string | null) ?? null;
  if (head !== baseSnapshotId) {
    const conflicting = conflictingPaths(store, blobs, scope, patch, head);
    throw new WorkbenchError(
      ERROR_CODES.STALE_BASE,
      `patch ${patchId} is based on ${baseSnapshotId} but head is ${head}; conflicting paths: ${conflicting.join(",") || "none"}`,
      { retryable: false },
    );
  }

  const stored = JSON.parse(patch["operations_json"] as string) as {
    reason: string;
    operations: FileOperation[];
    diffArtifactId: string;
  };
  const protectedChanges = JSON.parse(patch["protected_changes_json"] as string) as ProtectedChange[];
  const needsApproval = protectedChanges.length > 0;

  // Recompute the patch digest — a tampered row must not apply.
  const opsDigest = sha256Hex(
    utf8Bytes(
      canonicalJson({
        baseSnapshotId,
        operations: stored.operations,
        reason: stored.reason,
        diff: stored.diffArtifactId.replace(/^diff-/, ""),
      }),
    ),
  );
  if (opsDigest !== (patch["patch_digest"] as string)) {
    throw new WorkbenchError(
      ERROR_CODES.DIGEST_MISMATCH,
      `patch ${patchId} digest mismatch — stored operations do not match the approved digest`,
    );
  }

  // Approval comes from the host context's grant store — never from params.
  let approval: Row | null = null;
  let authorization: PatchApplyOutcome["authorization"] = needsApproval ? "host-grant" : "not-required";
  if (needsApproval) {
    store.expireApprovals(scope, utcNowIso());
    approval = store.findUsableApproval(
      scope,
      APPROVABLE_ACTION,
      patch["patch_digest"] as string,
      baseSnapshotId,
      ctx.policyId,
      utcNowIso(),
    );
    if (
      approval === null &&
      opts.protectionMode === "authoring" &&
      protectedChanges.every(isAdditiveChange)
    ) {
      // The host pre-authorized additions for this session: record a real,
      // patch-bound grant (same table, same consumption path) so the audit
      // trail shows who authorized what, then fall through to consume it.
      const grant = grantApproval({
        store,
        scope,
        hostPrincipal: ctx.principalId,
        action: APPROVABLE_ACTION,
        scopeDigest: patch["patch_digest"] as string,
        baseSnapshotId,
        policyId: ctx.policyId,
        expiresInSeconds: 300,
        grantedVia: "host-authoring-mode",
      });
      approval = store.getApproval(scope, grant.approvalId);
      authorization = "authoring-mode";
    }
    if (approval === null) {
      const modified = protectedChanges.filter((c) => !isAdditiveChange(c));
      throw new WorkbenchError(
        ERROR_CODES.POLICY_DENIED,
        `patch ${patchId} has ${protectedChanges.length} protected change(s) and requires a host approval for action '${APPROVABLE_ACTION}' bound to digest ${patch["patch_digest"]}` +
          (opts.protectionMode === "authoring" && modified.length > 0
            ? ` (authoring mode covers additions only; ${modified.length} change(s) modify or remove existing protected content: ${[...new Set(modified.map((c) => c.category))].join(", ")})`
            : ""),
        { retryable: false },
      );
    }
  }

  // Re-verify every operation against CURRENT base content — same staleness
  // rules as propose: edits/deletes need the exact expected hash, attach-asset
  // must not clobber a file that appeared since the proposal, create must not
  // overwrite one either.
  const base = loadBaseFiles(store, blobs, scope, baseSnapshotId);
  for (const op of stored.operations) {
    const p = (op as { path: string }).path.normalize("NFC");
    if (op.op === "edit" || op.op === "delete") {
      const f = base.get(p);
      if (f === undefined || f.sha256 !== op.expectedSha256) {
        throw new WorkbenchError(
          ERROR_CODES.STALE_BASE,
          `file ${p} changed since proposal (expected ${op.expectedSha256})`,
          { retryable: false },
        );
      }
    } else if (op.op === "attach-asset") {
      const f = base.get(p);
      if (op.expectedSha256 === null) {
        if (f !== undefined) {
          throw new WorkbenchError(
            ERROR_CODES.STALE_BASE,
            `file ${p} appeared since the proposal; attach-asset would clobber it`,
            { retryable: false },
          );
        }
      } else if (f === undefined || f.sha256 !== op.expectedSha256) {
        throw new WorkbenchError(
          ERROR_CODES.STALE_BASE,
          `file ${p} changed since proposal (expected ${op.expectedSha256})`,
          { retryable: false },
        );
      }
    } else if (op.op === "create" && base.has(p)) {
      throw new WorkbenchError(
        ERROR_CODES.STALE_BASE,
        `file ${p} appeared since the proposal; create would overwrite it`,
        { retryable: false },
      );
    }
  }

  const newFiles = new Map<string, { content: Uint8Array; role: string }>();
  for (const [p, f] of base) newFiles.set(p, { content: f.content, role: f.role });
  for (const op of stored.operations) {
    const p = (op as { path: string }).path.normalize("NFC");
    switch (op.op) {
      case "attach-asset": {
        const artifact = store.getArtifact(scope, op.artifactId);
        if (artifact === null) {
          throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `artifact ${op.artifactId} no longer exists`);
        }
        const blob = blobs.getVerified(artifact["blob_hash"] as string);
        newFiles.set(p, { content: blob, role: classifyRole(p) });
        break;
      }
      case "edit": {
        const f = base.get(p) as BaseFile;
        const sorted = [...op.edits].sort((a, b) => a.startByte - b.startByte);
        const out: number[] = [];
        let cursor = 0;
        for (const e of sorted) {
          for (let k = cursor; k < e.startByte; k += 1) out.push(f.content[k] as number);
          for (const byte of utf8Bytes(e.replacement)) out.push(byte);
          cursor = e.endByte;
        }
        for (let k = cursor; k < f.content.length; k += 1) out.push(f.content[k] as number);
        newFiles.set(p, { content: new Uint8Array(out), role: f.role });
        break;
      }
      case "create":
        newFiles.set(p, { content: utf8Bytes(op.content), role: classifyRole(p) });
        break;
      case "delete":
        newFiles.delete(p);
        break;
      case "replace":
        throw new WorkbenchError(ERROR_CODES.DIGEST_MISMATCH, `stored patch ${patchId} carries an unresolved replace operation`);
    }
  }

  // Write new blobs first (CAS is atomic), then commit metadata + head + patch
  // + event in ONE transaction.
  const manifestFiles: SnapshotFile[] = [...newFiles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, f]) => {
      const hash = blobs.put(f.content).hash;
      return {
        path,
        sha256: hash,
        bytes: f.content.length,
        role: f.role as SnapshotFile["role"],
        executable: false,
      };
    });

  const snapshotId = `snap-${randomUUID()}`;
  const createdAt = utcNowIso();
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    id: snapshotId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    parentSnapshotId: baseSnapshotId,
    treeHash: "",
    createdAt,
    files: manifestFiles,
  };
  manifest.treeHash = digestJson({ files: manifestFiles, parentSnapshotId: baseSnapshotId, projectId: scope.projectId });

  inTransaction(store.db, () => {
    store.insertSnapshot(scope, {
      snapshotId,
      parentSnapshotId: baseSnapshotId,
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
    const revision = (project?.["revision"] as number) ?? 0;
    if (!store.updateHeadSnapshot(scope, snapshotId, revision)) {
      throw new WorkbenchError(ERROR_CODES.STALE_BASE, "project head moved during patch apply", {
        retryable: true,
      });
    }
    const ok = store.updatePatchStateCas(scope, patchId, ["proposed", "waiting-approval"], "applied", snapshotId);
    if (!ok) {
      throw new WorkbenchError(
        ERROR_CODES.STALE_BASE,
        `patch ${patchId} changed state concurrently; apply aborted`,
        { retryable: true },
      );
    }
    if (approval !== null) {
      const consumed = store.transitionApproval(
        scope,
        approval["approval_id"] as string,
        "granted",
        "consumed",
      );
      if (!consumed) {
        throw new WorkbenchError(
          ERROR_CODES.POLICY_DENIED,
          `approval ${approval["approval_id"]} was consumed or revoked concurrently`,
        );
      }
    }
    store.emitProjectEventInTx(scope, {
      jobId: null,
      createdAt,
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
          payload: { previousSnapshotId: baseSnapshotId, snapshotId },
        }),
    });
  });

  return {
    kind: "patch-applied",
    patchId,
    previousSnapshotId: baseSnapshotId,
    snapshotId,
    treeHash: manifest.treeHash,
    materialization: "not-requested",
    authorization,
    approvalId: (approval?.["approval_id"] as string | undefined) ?? null,
  };
}

function conflictingPaths(
  store: WorkbenchStore,
  blobs: BlobStore,
  scope: Scope,
  patch: Row,
  head: string | null,
): string[] {
  const ops = (JSON.parse(patch["operations_json"] as string) as { operations: FileOperation[] }).operations;
  const touched = [...new Set(ops.map((o) => (o as { path: string }).path.normalize("NFC")))];
  const headFiles = head === null ? new Map<string, BaseFile>() : loadBaseFiles(store, blobs, scope, head);
  const conflicts: string[] = [];
  for (const p of touched) {
    const f = headFiles.get(p);
    const op = ops.find((o) => (o as { path: string }).path.normalize("NFC") === p) as FileOperation;
    if ("expectedSha256" in op && op.expectedSha256 !== null && f !== undefined && f.sha256 !== op.expectedSha256) {
      conflicts.push(p);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

/**
 * Build the inverse patch of an applied patch and run it through the same
 * propose path — a revert is a new proposal with its own review/apply.
 *
 * Inverse operations are expressed as text `edit`/`create`/`delete`, so a
 * file whose pre-patch bytes are not valid UTF-8 cannot be represented
 * (there is no raw-bytes operation). Rather than degrade to empty content,
 * proposeRevert throws WorkbenchError naming the path — restore binary
 * files by proposing an attach-asset against a registered artifact instead.
 */
export function proposeRevert(opts: Options & {
  patchId: string;
  reason: string;
  citekeyMapping?: Record<string, string> | undefined;
}): PatchProposal {
  const { store, blobs, scope, patchId } = opts;
  const patch = store.getPatch(scope, patchId);
  if (patch === null) {
    throw new WorkbenchError(ERROR_CODES.NOT_FOUND, `patch ${patchId} not found`);
  }
  if ((patch["state"] as string) !== "applied") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `only applied patches can be reverted; ${patchId} is '${patch["state"]}'`,
    );
  }
  const resultSnapshotId = patch["result_snapshot_id"] as string;
  const baseSnapshotId = patch["base_snapshot_id"] as string;
  const base = loadBaseFiles(store, blobs, scope, baseSnapshotId);
  const result = loadBaseFiles(store, blobs, scope, resultSnapshotId);
  const stored = JSON.parse(patch["operations_json"] as string) as {
    operations: FileOperation[];
  };

  const inverse: FileOperation[] = [];
  for (const op of stored.operations) {
    const p = (op as { path: string }).path.normalize("NFC");
    switch (op.op) {
      case "create": {
        const cur = result.get(p);
        inverse.push({ op: "delete", path: p, expectedSha256: cur?.sha256 ?? "0".repeat(64) });
        break;
      }
      case "delete": {
        const old = base.get(p);
        if (old === undefined) {
          throw new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, `cannot reconstruct deleted file ${p}`);
        }
        const text = decodeText(old.content);
        if (text === null) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `cannot revert ${p}: base content is not valid UTF-8 and a text inverse is not expressible — propose attach-asset against a registered artifact instead`,
          );
        }
        inverse.push({ op: "create", path: p, content: text });
        break;
      }
      case "attach-asset": {
        const cur = result.get(p);
        if (op.expectedSha256 === null) {
          // Asset did not exist before — inverse is delete.
          inverse.push({ op: "delete", path: p, expectedSha256: cur?.sha256 ?? "0".repeat(64) });
        } else {
          const old = base.get(p);
          if (old === undefined) {
            throw new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, `cannot reconstruct pre-attach file ${p}`);
          }
          const text = decodeText(old.content);
          if (text === null) {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_REQUEST,
              `cannot revert ${p}: pre-attach content is not valid UTF-8 — propose attach-asset against a registered artifact instead`,
            );
          }
          inverse.push({
            op: "edit",
            path: p,
            expectedSha256: cur?.sha256 ?? "0".repeat(64),
            edits: [{ startByte: 0, endByte: cur?.bytes ?? 0, replacement: text }],
          });
        }
        break;
      }
      case "edit": {
        const old = base.get(p);
        const cur = result.get(p);
        if (old === undefined || cur === undefined) {
          throw new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, `cannot reconstruct edit revert for ${p}`);
        }
        const text = decodeText(old.content);
        if (text === null) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `cannot revert ${p}: pre-edit content is not valid UTF-8 and a text inverse is not expressible — propose attach-asset against a registered artifact instead`,
          );
        }
        inverse.push({
          op: "edit",
          path: p,
          expectedSha256: cur.sha256,
          edits: [
            { startByte: 0, endByte: cur.bytes, replacement: text },
          ],
        });
        break;
      }
    }
  }

  return proposePatch({
    ...opts,
    baseSnapshotId: resultSnapshotId,
    operations: inverse,
    reason: opts.reason,
    citekeyMapping: opts.citekeyMapping,
  });
}
