/**
 * An in-memory WorkspacePort for the offline delegate tests and the labelled
 * mock path. It behaves like the host where it matters:
 *
 * - revisions are immutable snapshots; reads name the revision they read;
 * - staging materializes a patch on its base in a separate snapshot and never
 *   moves the user's current revision; the same patch on the same base is the
 *   same revision;
 * - the apply is a compare-and-swap on the base revision: a workspace that
 *   moved is `PATCH_CONFLICT` and nothing is written (DEL-04);
 * - `..`, absolute paths, credential directories and paths the fixture marks
 *   as symlinks out of the root are refused on every operation (DEL-05).
 */

import { sha256Hex } from "../util/sha256"
import {
  normalizeDelegatePath,
  type ApplyPatchResult,
  type DelegatePathRefusal,
  type DelegatePatch,
  type StagePatchResult,
  type WorkspaceListResult,
  type WorkspacePort,
  type WorkspaceReadResult,
} from "../workflows/delegate-ports"

export interface MemoryWorkspaceOptions {
  revision?: string
  /** Paths that are symlinks resolving outside the root; any operation on them is refused. */
  symlinkEscapes?: string[]
  /** Paths whose content the host's PII gate refuses to show a model. */
  sensitiveContent?: string[]
}

export class MemoryWorkspace implements WorkspacePort {
  readonly snapshots = new Map<string, Map<string, string>>()
  readonly staged: Array<{ revision: string; patch: DelegatePatch; logicalStepId: string }> = []
  readonly applied: Array<{
    revision: string
    patch: DelegatePatch
    baseRevision: string
    approvalId: string
  }> = []
  readonly conflicts: Array<{ baseRevision: string; currentRevision: string }> = []
  current: string
  private readonly symlinkEscapes: Set<string>
  private readonly sensitiveContent: Set<string>
  private edits = 0

  constructor(files: Record<string, string>, options: MemoryWorkspaceOptions = {}) {
    this.current = options.revision ?? "rev-0"
    this.snapshots.set(this.current, new Map(Object.entries(files)))
    this.symlinkEscapes = new Set(options.symlinkEscapes ?? [])
    this.sensitiveContent = new Set(options.sensitiveContent ?? [])
  }

  /** Someone edits the user's workspace: a new current revision. */
  externalEdit(path: string, content: string): string {
    const next = new Map(this.snapshots.get(this.current))
    next.set(path, content)
    const revision = `rev-edit-${++this.edits}`
    this.snapshots.set(revision, next)
    this.current = revision
    return revision
  }

  filesAt(revision: string): Record<string, string> | null {
    const snapshot = this.snapshots.get(revision)
    return snapshot ? Object.fromEntries(snapshot) : null
  }

  private refusal(raw: string): { code: DelegatePathRefusal | "PATH_ESCAPE"; path: string } | null {
    const normalized = normalizeDelegatePath(raw)
    if (!normalized.ok) return { code: normalized.code, path: raw }
    if (
      [...this.symlinkEscapes].some(
        (link) => normalized.path === link || normalized.path.startsWith(`${link}/`)
      )
    ) {
      return { code: "PATH_ESCAPE", path: normalized.path }
    }
    return null
  }

  async currentRevision(): Promise<string> {
    return this.current
  }

  async readFile(input: {
    path: string
    revision: string
    maxBytes: number
  }): Promise<WorkspaceReadResult> {
    const refused = this.refusal(input.path)
    if (refused) {
      return { ok: false, code: refused.code, message: `refused: ${refused.code}` }
    }
    const snapshot = this.snapshots.get(input.revision)
    if (!snapshot) return { ok: false, code: "REVISION_UNKNOWN", message: input.revision }
    const path = (normalizeDelegatePath(input.path) as { path: string }).path
    const content = snapshot.get(path)
    if (content === undefined) return { ok: false, code: "NOT_FOUND", message: path }
    if (this.sensitiveContent.has(path)) {
      return { ok: false, code: "CONTENT_SENSITIVE", message: "refused: CONTENT_SENSITIVE" }
    }
    const bytes = new TextEncoder().encode(content)
    const truncated = bytes.byteLength > input.maxBytes
    const shown = truncated ? new TextDecoder().decode(bytes.slice(0, input.maxBytes)) : content
    return { ok: true, content: shown, contentSha256: sha256Hex(content), truncated }
  }

  async listFiles(input: {
    prefix: string
    revision: string
    limit: number
  }): Promise<WorkspaceListResult> {
    const snapshot = this.snapshots.get(input.revision)
    if (!snapshot) return { ok: false, code: "REVISION_UNKNOWN", message: input.revision }
    let prefix = ""
    if (input.prefix.trim().length > 0) {
      const refused = this.refusal(input.prefix)
      if (refused) {
        return { ok: false, code: refused.code, message: `refused: ${refused.code}` }
      }
      prefix = (normalizeDelegatePath(input.prefix) as { path: string }).path
    }
    const all = [...snapshot.entries()]
      .filter(([path]) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`))
      .filter(([path]) => this.refusal(path) === null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return {
      ok: true,
      files: all.slice(0, input.limit).map(([path, content]) => ({
        path,
        sizeBytes: new TextEncoder().encode(content).byteLength,
      })),
      truncated: all.length > input.limit,
    }
  }

  private applyTo(
    base: Map<string, string>,
    patch: DelegatePatch
  ): { ok: true; files: Map<string, string> } | { ok: false; message: string; path: string } {
    const next = new Map(base)
    for (const file of patch.files) {
      const refused = this.refusal(file.path)
      if (refused) return { ok: false, message: `refused: ${refused.code}`, path: file.path }
      if (file.action === "write") {
        if (file.content === null || sha256Hex(file.content) !== file.content_sha256) {
          return {
            ok: false,
            message: "the file's content does not match its hash",
            path: file.path,
          }
        }
        next.set(file.path, file.content)
      } else {
        next.delete(file.path)
      }
    }
    return { ok: true, files: next }
  }

  async stagePatch(input: {
    runId: string
    logicalStepId: string
    patch: DelegatePatch
  }): Promise<StagePatchResult> {
    const base = this.snapshots.get(input.patch.base_revision)
    if (!base) {
      return {
        ok: false,
        code: "REVISION_UNKNOWN",
        message: `no revision ${input.patch.base_revision}`,
        path: null,
      }
    }
    const next = this.applyTo(base, input.patch)
    if (!next.ok)
      return { ok: false, code: "PATCH_REFUSED", message: next.message, path: next.path }
    const revision = `rev-staged-${sha256Hex(JSON.stringify(input.patch)).slice(0, 12)}`
    this.snapshots.set(revision, next.files)
    this.staged.push({ revision, patch: input.patch, logicalStepId: input.logicalStepId })
    return { ok: true, revision }
  }

  async applyPatchCAS(input: {
    patch: DelegatePatch
    baseRevision: string
    approvalId: string
  }): Promise<ApplyPatchResult> {
    if (this.current !== input.baseRevision || input.patch.base_revision !== input.baseRevision) {
      this.conflicts.push({ baseRevision: input.baseRevision, currentRevision: this.current })
      return {
        ok: false,
        code: "PATCH_CONFLICT",
        currentRevision: this.current,
        message: `the workspace is at ${this.current}, not ${input.baseRevision}`,
      }
    }
    const base = this.snapshots.get(this.current) as Map<string, string>
    const next = this.applyTo(base, input.patch)
    if (!next.ok)
      return { ok: false, code: "PATCH_REFUSED", message: next.message, path: next.path }
    const revision = `rev-applied-${this.applied.length + 1}`
    this.snapshots.set(revision, next.files)
    this.current = revision
    this.applied.push({
      revision,
      patch: input.patch,
      baseRevision: input.baseRevision,
      approvalId: input.approvalId,
    })
    return { ok: true, revision }
  }
}
