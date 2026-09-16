/**
 * Read-only workspace access for a panel candidate (ADR-0188 D26, DESIGN §10/§12.4).
 *
 * Three layers, each one on its own enough to refuse an escape:
 *
 * 1. Here, before any I/O: the path must be workspace-relative, with no `..`
 *    segment, no absolute or drive prefix, and no credential-shaped name or
 *    credential directory (`.env`, keys, `.ssh`, `.aws`, …).
 * 2. In Rust (`fs_read_workspace_file`): the root and the target are both
 *    canonicalized — symlinks followed — and a real location outside the root
 *    is refused on disk.
 * 3. In the tool runtime: only a read-only policy can reach this at all.
 *
 * A file whose content fails the PII gate (an email address, an ID number, a
 * key) is refused like a credential path: it would leave the device inside a
 * model request.
 *
 * Every read is pinned by the SHA-256 of what it returned, and that hash is
 * part of the operation's identity: the same arguments on a changed file are a
 * new operation with a new receipt, never the old content (CACHE-02).
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { sha256Hex } from "@cognia/router-fusion"
import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"

/** Bytes a candidate may read from one file; the receipt says when it was cut. */
export const WORKSPACE_READ_MAX_BYTES = 64_000

const CREDENTIAL_DIRECTORIES: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
])

export type WorkspacePathRefusal =
  "PATH_ABSOLUTE" | "PATH_TRAVERSAL" | "PATH_SENSITIVE" | "PATH_EMPTY"

/** Why a requested path is refused before anything is read; null when it may be read. */
export function workspacePathRefusal(relPath: string): WorkspacePathRefusal | null {
  const trimmed = relPath.trim()
  if (trimmed.length === 0) return "PATH_EMPTY"
  const normalized = trimmed.replaceAll("\\", "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("~")) {
    return "PATH_ABSOLUTE"
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.length === 0) return "PATH_EMPTY"
  if (segments.some((segment) => segment === "..")) return "PATH_TRAVERSAL"
  if (segments.some((segment) => CREDENTIAL_DIRECTORIES.has(segment.toLowerCase())))
    return "PATH_SENSITIVE"
  if (isSensitiveResourcePath(segments.join("/"))) return "PATH_SENSITIVE"
  return null
}

export type WorkspaceReadResult =
  | { ok: true; relPath: string; content: string; contentSha256: string; truncated: boolean }
  | { ok: false; code: WorkspacePathRefusal | "CONTENT_SENSITIVE" | "READ_FAILED"; message: string }

export interface WorkspaceReaderDeps {
  /** `fs_read_workspace_file` in production. */
  read: (root: string, relPath: string, maxBytes: number) => Promise<string>
}

export interface WorkspaceReader {
  root: string
  read(relPath: string): Promise<WorkspaceReadResult>
}

const TRUNCATION_MARKER = "\n... (truncated)"

export function createWorkspaceReader(root: string, deps: WorkspaceReaderDeps): WorkspaceReader {
  return {
    root,
    async read(relPath) {
      const refusal = workspacePathRefusal(relPath)
      if (refusal) return { ok: false, code: refusal, message: `refused: ${refusal}` }
      const normalized = relPath.trim().replaceAll("\\", "/")
      try {
        const content = await deps.read(root, normalized, WORKSPACE_READ_MAX_BYTES)
        // A file is local data on its way to a model: the PII gate every such
        // path passes applies, before the content is hashed or stored.
        if (!hasNoLeakingPii(content)) {
          return { ok: false, code: "CONTENT_SENSITIVE", message: "refused: CONTENT_SENSITIVE" }
        }
        return {
          ok: true,
          relPath: normalized,
          content,
          contentSha256: sha256Hex(content),
          truncated: content.endsWith(TRUNCATION_MARKER),
        }
      } catch (error) {
        // "path escapes workspace" from the Rust guard lands here too; the
        // receipt names the failure without echoing the host's path.
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          code: /escapes workspace/i.test(message) ? "PATH_TRAVERSAL" : "READ_FAILED",
          message: /escapes workspace/i.test(message)
            ? "refused: PATH_TRAVERSAL"
            : "the file could not be read",
        }
      }
    },
  }
}

/** The production reader, over the host's guarded workspace file command. */
export async function hostWorkspaceReader(root: string): Promise<WorkspaceReader> {
  const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
  return createWorkspaceReader(root, { read: readWorkspaceFile })
}
