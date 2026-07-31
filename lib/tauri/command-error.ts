/**
 * Decode a Tauri `invoke()` rejection into a structured, retry-aware error.
 *
 * Rust commands are migrating from `Result<_, String>` to the object envelope
 * `{ code, message, retryable }` (`src-tauri/src/command_error.rs`; the
 * scheduler commands are the first adopters, `VscodeCommandError` shares the
 * shape). `parseInvokeError` is the single tolerant seam: it decodes the
 * envelope when present and degrades gracefully for legacy plain-string /
 * Error rejections, so callers never need to know which era a command is in.
 *
 * Mirrors the companion transport's `CompanionError`
 * (`lib/tauri/transport-companion.ts`) — same code/retryable vocabulary.
 */

export interface ParsedCommandError {
  /** Stable snake_case code; "unknown" for legacy plain-string rejections. */
  code: string
  message: string
  /** False when unknown — never invent retryability. */
  retryable: boolean
  /** True when the rejection carried a structured envelope. */
  structured: boolean
}

export interface CommandErrorEnvelope {
  code: string
  message: string
  retryable?: boolean
}

export function isCommandErrorEnvelope(value: unknown): value is CommandErrorEnvelope {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    (v.retryable === undefined || typeof v.retryable === "boolean")
  )
}

export function parseInvokeError(err: unknown): ParsedCommandError {
  if (isCommandErrorEnvelope(err)) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable === true,
      structured: true,
    }
  }
  if (err instanceof Error) {
    return { code: "unknown", message: err.message, retryable: false, structured: false }
  }
  if (typeof err === "string") {
    return { code: "unknown", message: err, retryable: false, structured: false }
  }
  return { code: "unknown", message: String(err), retryable: false, structured: false }
}

/**
 * Error subclass carrying the decoded envelope — for wrappers that re-throw
 * so downstream `instanceof Error` / `.message` handling keeps working while
 * `code`/`retryable` become available to callers that look for them.
 */
export class CommandInvokeError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly structured: boolean

  constructor(parsed: ParsedCommandError) {
    super(parsed.message)
    this.name = "CommandInvokeError"
    this.code = parsed.code
    this.retryable = parsed.retryable
    this.structured = parsed.structured
  }
}

/** Re-throw helper: `invoke(...).catch(rethrowInvokeError)`. */
export function rethrowInvokeError(err: unknown): never {
  throw new CommandInvokeError(parseInvokeError(err))
}
