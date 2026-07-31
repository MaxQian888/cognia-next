/**
 * Secure file-IO façade.
 *
 * Wraps the cross-runtime primitives in `lib/file/file-operations.ts` with the
 * three things every file touch in the app should have but currently has to
 * re-implement ad-hoc:
 *
 *   1. a permission check against a `FileAccessPolicy` (see `permissions.ts`),
 *   2. a structured log line through the unified logger (`lib/logging`), and
 *   3. an audit record in the in-memory ring buffer (`audit.ts`).
 *
 * Payload contents are never logged — only operation, path, byte counts, and
 * timing — so this stays clear of the PII redaction gate. Denied operations
 * throw `FileAccessError`; runtime failures propagate the underlying error
 * after being logged and audited.
 */

import { loggers } from "@cognia/logging"
import type { Logger } from "@/types/logging"
import type { FileAccessDecision, FileAccessPolicy, FileOperation, FileStat } from "@/types/files"
import {
  copyFile,
  createDir,
  exists as existsOp,
  readBinaryFile,
  readDir,
  readTextFile,
  removeFile,
  renameFile,
  statFile,
  writeBinaryFile,
  writeTextFile,
} from "@/lib/file/file-operations"
import { checkFileAccess } from "./permissions"
import { confinedOps, type ConfinedOps } from "./confined-ops"
import { createFileAuditEntry, recordFileAudit } from "./audit"

/** Thrown when the active policy denies an operation. */
export class FileAccessError extends Error {
  readonly op: FileOperation
  readonly path: string
  readonly decision: FileAccessDecision

  constructor(op: FileOperation, path: string, decision: FileAccessDecision) {
    super(`file access denied: ${op} ${path} — ${decision.detail ?? decision.reason}`)
    this.name = "FileAccessError"
    this.op = op
    this.path = path
    this.decision = decision
  }
}

/** The slice of the unified `Logger` the façade uses. */
type FsLogger = Pick<Logger, "info" | "warn" | "error" | "debug">

export interface SecureFsOptions {
  /** Logger to emit through; defaults to the shared `files` logger. */
  logger?: FsLogger
  /** Record to the audit ring buffer. Default: true. */
  audit?: boolean
  /**
   * Confined write/mkdir backend (the authoritative on-disk gate). Defaults to
   * the Rust-backed `confinedOps`; injectable for tests. Used for writes inside
   * a rooted policy; `allowAnyPath` / root-less policies fall back to the raw
   * primitive (those are trusted, user-gesture-gated flows).
   */
  confined?: ConfinedOps
}

interface RunMeta<T> {
  /** Known byte count up front (writes) — checked against `policy.maxBytes`. */
  bytes?: number
  /** Destination path for copy/move — also confined to the policy roots. */
  destPath?: string
  /** Derive the byte count from the result (reads) for logging / audit. */
  resolveBytes?: (result: T) => number
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length
  return value.length
}

/**
 * A policy-scoped view over the filesystem. Construct one per scope (a
 * workspace, a plugin sandbox dir, a read-only export root) and call its
 * methods instead of the raw `file-operations` helpers.
 */
export class SecureFileSystem {
  private readonly logger: FsLogger
  private readonly auditEnabled: boolean
  private readonly confined: ConfinedOps

  constructor(
    readonly policy: FileAccessPolicy,
    options: SecureFsOptions = {}
  ) {
    this.logger = options.logger ?? loggers.files
    this.auditEnabled = options.audit ?? true
    this.confined = options.confined ?? confinedOps
  }

  /** Derive a new façade with a different policy, sharing logger/audit config. */
  withPolicy(policy: FileAccessPolicy): SecureFileSystem {
    return new SecureFileSystem(policy, {
      logger: this.logger,
      audit: this.auditEnabled,
      confined: this.confined,
    })
  }

  /** True when the policy has concrete roots to confine an on-disk write to. */
  private get canConfine(): boolean {
    return this.policy.allowAnyPath !== true && this.policy.allowedRoots.length > 0
  }

  private async run<T>(
    op: FileOperation,
    path: string,
    exec: () => Promise<T>,
    meta: RunMeta<T> = {}
  ): Promise<T> {
    const started = Date.now()
    const decision = checkFileAccess(path, op, this.policy, {
      bytes: meta.bytes,
      destPath: meta.destPath,
    })

    if (!decision.allowed) {
      this.logger.warn("file access denied", {
        op,
        path,
        destPath: meta.destPath,
        reason: decision.reason,
        detail: decision.detail,
      })
      if (this.auditEnabled) {
        recordFileAudit(
          createFileAuditEntry({
            op,
            path,
            destPath: meta.destPath,
            allowed: false,
            error: decision.detail ?? decision.reason,
          })
        )
      }
      throw new FileAccessError(op, path, decision)
    }

    try {
      const result = await exec()
      const durationMs = Date.now() - started
      const bytes = meta.resolveBytes ? meta.resolveBytes(result) : meta.bytes
      this.logger.info("file op", { op, path, destPath: meta.destPath, bytes, durationMs })
      if (this.auditEnabled) {
        recordFileAudit(
          createFileAuditEntry({
            op,
            path,
            destPath: meta.destPath,
            allowed: true,
            bytes,
            durationMs,
          })
        )
      }
      return result
    } catch (err) {
      const durationMs = Date.now() - started
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error("file op failed", err, { op, path, destPath: meta.destPath, durationMs })
      if (this.auditEnabled) {
        recordFileAudit(
          createFileAuditEntry({
            op,
            path,
            destPath: meta.destPath,
            allowed: true,
            durationMs,
            error: message,
          })
        )
      }
      throw err
    }
  }

  /** Read a UTF-8 text file. */
  readText(path: string): Promise<string> {
    return this.run("read", path, () => readTextFile(path), {
      resolveBytes: (r) => utf8ByteLength(r),
    })
  }

  /**
   * Write a UTF-8 text file (parent dirs created by the runtime). Inside a
   * rooted policy the write goes through the Rust-confined command so a path
   * that escapes the roots — including via a symlink the lexical pre-flight
   * can't see — is rejected on-disk; root-less / `allowAnyPath` policies use
   * the raw primitive.
   */
  writeText(path: string, content: string): Promise<void> {
    const exec = this.canConfine
      ? () => this.confined.writeText(path, content, this.policy.allowedRoots)
      : () => writeTextFile(path, content)
    return this.run("write", path, exec, { bytes: utf8ByteLength(content) })
  }

  /** Read a file as raw bytes. */
  readBinary(path: string): Promise<Uint8Array> {
    return this.run("read", path, () => readBinaryFile(path), {
      resolveBytes: (r) => r.length,
    })
  }

  /** Write raw bytes to a file. */
  writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.run("write", path, () => writeBinaryFile(path, data), { bytes: data.length })
  }

  /** Remove a file or (with `recursive`) a directory. */
  remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.run("delete", path, () => removeFile(path, options))
  }

  /** Copy a file; both source and destination must be inside the policy. */
  copy(fromPath: string, toPath: string): Promise<void> {
    return this.run("copy", fromPath, () => copyFile(fromPath, toPath), { destPath: toPath })
  }

  /** Move / rename; both source and destination must be inside the policy. */
  move(fromPath: string, toPath: string): Promise<void> {
    return this.run("move", fromPath, () => renameFile(fromPath, toPath), { destPath: toPath })
  }

  /** Stat a path, returning normalized metadata. */
  stat(path: string): Promise<FileStat> {
    return this.run("stat", path, () => statFile(path))
  }

  /** List a directory's immediate entry names. */
  list(path: string): Promise<string[]> {
    return this.run("list", path, () => readDir(path))
  }

  /** Create a directory (recursive by default), confined to the policy roots. */
  mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const exec = this.canConfine
      ? () => this.confined.mkdir(path, this.policy.allowedRoots)
      : () => createDir(path, options)
    return this.run("mkdir", path, exec)
  }

  /** Check whether a path exists (gated as a non-mutating stat). */
  exists(path: string): Promise<boolean> {
    return this.run("stat", path, () => existsOp(path))
  }
}

/** Convenience factory mirroring the other `create*` helpers in the codebase. */
export function createSecureFs(
  policy: FileAccessPolicy,
  options?: SecureFsOptions
): SecureFileSystem {
  return new SecureFileSystem(policy, options)
}
