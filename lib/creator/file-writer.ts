/**
 * The only way a Creator run puts bytes on disk (ADR-0117, Phase 3).
 *
 * Three gates, in this order, and none of them is optional:
 *
 *  1. **Run state** — `canWrite()` must hold, meaning the permission diff was
 *     approved and that approval has not been withdrawn. Checked here rather
 *     than trusted from the caller, because the UI is not the boundary.
 *  2. **Lexical pre-flight** — `checkCreatorAccess()` resolves `..` and matches
 *     the authoring root and the secret deny globs. Fast, translatable, and the
 *     only check available in web mode.
 *  3. **Authoritative on-disk containment** — `confinedOps.writeText`, i.e. the
 *     Rust `*_confined` command, which canonicalizes and rejects a write that
 *     escapes through a symlink. The lexical check cannot see symlinks; this
 *     one can, which is why both run.
 *
 * The run log records the relative path and byte count of every write, never
 * the contents.
 */

import { confinedOps } from "@/lib/files/confined-ops"
import type { ConfinedOps } from "@/lib/files/confined-ops"
import { checkCreatorAccess } from "./authoring-root"
import { canWrite } from "./steps"
import type { CreatorAdvanceState } from "./steps"
import { relativeToAuthoringRoot } from "./run-log"
import type { CreatorRunLog } from "./run-log"
import type { AuthoringRoot } from "@/types/creator"
import type { FileAccessDecision } from "@/types/files"

export interface CreatorWriteRequest {
  /** Path relative to the authoring root. Absolute paths are rejected. */
  relativePath: string
  contents: string
}

export type CreatorWriteOutcome =
  | { ok: true; relativePath: string; bytes: number }
  | { ok: false; reason: "writes-not-approved" | "denied" | "host-error"; detail: string }

export interface CreatorWriterDeps {
  root: AuthoringRoot
  state: CreatorAdvanceState
  log?: Pick<CreatorRunLog, "fileWritten">
  /** Injected in tests; production uses the Rust-backed confined ops. */
  ops?: ConfinedOps
}

/**
 * Join a root-relative path onto the authoring root.
 *
 * Deliberately rejects anything that already looks absolute rather than
 * silently reinterpreting it: a generator that emits `/etc/passwd` has made a
 * mistake worth surfacing, and `join`-style silent rebasing would hide it.
 */
export function resolveAuthoringPath(root: AuthoringRoot, relativePath: string): string | null {
  const trimmed = relativePath.trim()
  if (trimmed === "") return null
  if (trimmed.startsWith("/") || /^[A-Za-z]:[/\\]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return null
  }
  const base = root.path.endsWith("/") ? root.path.slice(0, -1) : root.path
  return `${base}/${trimmed.replace(/^\.\//, "")}`
}

export async function writeCreatorFile(
  request: CreatorWriteRequest,
  deps: CreatorWriterDeps
): Promise<CreatorWriteOutcome> {
  // Gate 1: the run must have cleared the permission diff. This is checked
  // before the path is even resolved, so a caller that skipped the gate cannot
  // learn anything about the filesystem from the error it gets back.
  if (!canWrite(deps.state)) {
    return {
      ok: false,
      reason: "writes-not-approved",
      detail: "the permission diff has not been approved for this run",
    }
  }

  const absolute = resolveAuthoringPath(deps.root, request.relativePath)
  if (absolute === null) {
    return {
      ok: false,
      reason: "denied",
      detail: `"${request.relativePath}" is not a path relative to the authoring root`,
    }
  }

  const bytes = new TextEncoder().encode(request.contents).length

  // Gate 2: lexical containment + secret deny globs.
  const decision: FileAccessDecision = checkCreatorAccess({
    root: deps.root,
    path: absolute,
    op: "write",
    writesApproved: true,
    bytes,
  })
  if (!decision.allowed) {
    return { ok: false, reason: "denied", detail: decision.detail ?? decision.reason }
  }

  // Gate 3: authoritative on-disk containment in Rust.
  const ops = deps.ops ?? confinedOps
  try {
    await ops.writeText(absolute, request.contents, [deps.root.path])
  } catch (error) {
    return {
      ok: false,
      reason: "host-error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const relativePath = relativeToAuthoringRoot(deps.root, absolute)
  await deps.log?.fileWritten(relativePath, bytes)
  return { ok: true, relativePath, bytes }
}
