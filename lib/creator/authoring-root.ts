/**
 * The Creator authoring root — the boundary every Creator capability sits
 * inside (ADR-0117, Phase 3).
 *
 * This module does not implement containment. `lib/files/permissions.ts`
 * already owns that logic (root matching, `..` resolution, Windows drive/UNC
 * handling, segment-aware deny globs) and is exhaustively tested; reimplementing
 * it here would create a second, weaker boundary that drifts from the first.
 * What this module adds is the Creator-specific *policy*: exactly one root,
 * never implicit, plus a deny list that keeps generated code away from secrets
 * and VCS internals even inside a root the user chose.
 *
 * IMPORTANT — like the engine it delegates to, this is a *lexical* pre-flight.
 * It resolves `..` without touching the filesystem, so it cannot see a symlink
 * pointing out of the root. The authoritative check is the Rust `*_confined`
 * command in `src-tauri/src/files.rs`, which canonicalizes on disk. Creator
 * writes must go through that path; this check exists to deny early, in a
 * translatable way, and is the only check available in web mode.
 */

import { checkFileAccess, defaultFilePolicy, normalizeFsPath } from "@/lib/files/permissions"
import type { FileAccessDecision, FileAccessPolicy, FileOperation } from "@/types/files"
import type { AuthoringRoot } from "@/types/creator"

/**
 * Paths Creator may never touch, even inside its own root.
 *
 * A generated plugin has no reason to read a `.env` or write into `.git`, and
 * an authoring root that happens to be an existing checkout would otherwise
 * expose both.
 */
export const CREATOR_DENIED_GLOBS: readonly string[] = [
  "**/.git/**",
  "**/.env",
  "**/.env.*",
  "**/node_modules/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/.ssh/**",
  "**/.npmrc",
  "**/.netrc",
]

/** Largest single file Creator will write (1 MiB). */
export const CREATOR_MAX_FILE_BYTES = 1024 * 1024

export type AuthoringRootRejection = "empty" | "not-absolute" | "filesystem-root" | "home-directory"

export type AuthoringRootValidation =
  { valid: true; root: AuthoringRoot } | { valid: false; reason: AuthoringRootRejection }

export interface ValidateAuthoringRootInput {
  path: string
  label?: string
  origin?: AuthoringRoot["origin"]
  /** Epoch ms; injected so the result is deterministic in tests. */
  now: number
  /** The user's home directory, when the host can report it. */
  homeDir?: string
}

/**
 * Normalize and vet a candidate root.
 *
 * The filesystem root and the home directory are rejected outright: both are
 * technically "a directory the user chose", and both would make the containment
 * boundary meaningless while still looking like a granted scope.
 */
export function validateAuthoringRoot(input: ValidateAuthoringRootInput): AuthoringRootValidation {
  const path = normalizeFsPath(input.path)
  if (path === "") return { valid: false, reason: "empty" }
  if (!isAbsolutePath(path)) return { valid: false, reason: "not-absolute" }
  if (isFilesystemRoot(path)) return { valid: false, reason: "filesystem-root" }
  if (input.homeDir && normalizeFsPath(input.homeDir) === path) {
    return { valid: false, reason: "home-directory" }
  }

  return {
    valid: true,
    root: {
      path,
      label: input.label?.trim() || lastSegment(path),
      origin: input.origin ?? "selected",
      grantedAt: input.now,
    },
  }
}

function isAbsolutePath(normalized: string): boolean {
  return (
    normalized.startsWith("/") || // posix + UNC (//server/share)
    /^[A-Za-z]:\//.test(normalized) // Windows drive
  )
}

function isFilesystemRoot(normalized: string): boolean {
  if (normalized === "/") return true
  if (/^[A-Za-z]:\/?$/.test(normalized)) return true
  // `//server/share` with nothing under it is a share root. The trailing slash
  // is optional because `normalizeFsPath` keeps it on a bare root.
  return /^\/\/[^/]+\/[^/]+\/?$/.test(normalized)
}

function lastSegment(normalized: string): string {
  const parts = normalized.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? normalized
}

/**
 * The file policy for a granted root.
 *
 * `readOnly` exists so the survey and review steps — and the reviewer subagent,
 * which must never be able to edit what it is reviewing — can share the same
 * root without sharing its write capability.
 */
export function authoringRootPolicy(
  root: AuthoringRoot,
  options: { readOnly?: boolean } = {}
): FileAccessPolicy {
  return defaultFilePolicy([root.path], {
    readOnly: options.readOnly ?? false,
    deniedGlobs: [...CREATOR_DENIED_GLOBS],
    maxBytes: CREATOR_MAX_FILE_BYTES,
  })
}

export interface CreatorAccessInput {
  root: AuthoringRoot | null
  path: string
  op: FileOperation
  /** Whether the run has cleared the permission gate (`canWrite`). */
  writesApproved?: boolean
  bytes?: number
  destPath?: string
}

/**
 * The single entry point Creator file operations go through.
 *
 * Two Creator-specific denials come before the generic engine: no root at all,
 * and a mutating op while the permission diff is still unapproved. Both are
 * failures the generic engine cannot express, because both are about the state
 * of the *run* rather than the shape of the path.
 */
export function checkCreatorAccess(input: CreatorAccessInput): FileAccessDecision {
  if (!input.root) {
    return {
      allowed: false,
      reason: "no_roots",
      detail: "Creator has no authoring root; the user must choose one first",
    }
  }

  const mutating = input.op !== "read" && input.op !== "list" && input.op !== "stat"
  if (mutating && input.writesApproved !== true) {
    return {
      allowed: false,
      reason: "read_only",
      detail: "writes are blocked until the permission diff is approved",
    }
  }

  return checkFileAccess(
    input.path,
    input.op,
    authoringRootPolicy(input.root, {
      readOnly: !input.writesApproved,
    }),
    { bytes: input.bytes, destPath: input.destPath }
  )
}
