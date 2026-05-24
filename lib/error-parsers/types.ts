import type { StackFrame } from "@/lib/terminal/stack-trace"

/** A run of text sharing one ANSI SGR style, produced by the ANSI parser. */
export interface AnsiSegment {
  text: string
  /** Tailwind class(es) for the run's colour / weight; absent = default style. */
  className?: string
}

export interface ParsedNode {
  kind:
    | "json"
    | "log"
    | "stack"
    | "path"
    | "url"
    | "text"
    | "exitCode"
    | "statusCode"
    | "ansi"
    | "category"
  content: string
  /** JSON-specific: the parsed value, rendered as a collapsible tree. */
  value?: unknown
  /** Log-specific: extracted level. */
  level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal"
  /** Path/URL-specific: the raw href/path value. */
  href?: string
  /** Path-specific: line number for file viewer. */
  line?: number | null
  /** Path-specific: column number for file viewer. */
  column?: number | null
  /** Stack-specific: structured frames. */
  frames?: StackFrame[]
  /** Exit-code-specific: the numeric exit code. */
  exitCode?: number
  /** Status-code-specific: the numeric HTTP status code. */
  status?: number
  /** ANSI-specific: coloured text runs (escape codes already stripped). */
  segments?: AnsiSegment[]
  /**
   * Category-specific (also attachable to a `statusCode` node): a stable id —
   * e.g. `connectionRefused`, `rateLimited`, `sidecarExited` — that the
   * renderer maps to a localized label + actionable hint. Keeping it as an id
   * (not pre-rendered text) keeps the parsers i18n-free and pure.
   */
  category?: string
}

export interface ParsedError {
  nodes: ParsedNode[]
  /** Whether any parsing actually happened (vs. fallback to plain text). */
  parsed: boolean
}

export interface ErrorParser {
  name: string
  /**
   * Attempt to parse the raw error text.
   * Return `null` if this parser does not apply.
   */
  parse(text: string): ParsedError | null
}

export interface ErrorPreset {
  name: string
  parsers: ErrorParser[]
  parse(text: string): ParsedError
}
