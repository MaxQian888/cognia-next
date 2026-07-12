import { DEFAULTS } from "./defaults.js"
import type { SnapshotOptions, CodegenFramework, FrameworkHint } from "./schema.js"

/**
 * Safely parse an integer, returning `fallback` if the result is NaN.
 */
export function safeInt(val: string | undefined | null, fallback: number): number {
  if (val == null) return fallback
  const n = parseInt(val, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Validate that a string is a known codegen framework identifier.
 */
export function parseCodegenFramework(val: string | undefined): CodegenFramework | undefined {
  if (!val) return undefined
  const set: readonly string[] = DEFAULTS.codegenFrameworks
  const lower = val.toLowerCase()
  return (set as readonly string[]).includes(lower) ? (lower as CodegenFramework) : undefined
}

/**
 * Validate that a string is a known framework hint for extraction.
 */
export function parseFrameworkHint(val: string | undefined): FrameworkHint | undefined {
  if (!val) return undefined
  const set: readonly string[] = DEFAULTS.frameworkHints
  const lower = val.toLowerCase()
  return (set as readonly string[]).includes(lower) ? (lower as FrameworkHint) : undefined
}

/**
 * Unify boolean parsing: accept string "false" / "true", fallback to `defaultVal`.
 */
export function parseBool(val: string | boolean | undefined, defaultVal: boolean): boolean {
  if (typeof val === "boolean") return val
  if (val === undefined) return defaultVal
  if (val.toLowerCase() === "false") return false
  if (val.toLowerCase() === "true") return true
  return defaultVal
}

/**
 * Post-construction validation of SnapshotOptions.
 * Logs warnings for suspicious values but does not throw (best-effort).
 */
export function validateOptions(opts: SnapshotOptions): void {
  if (opts.maxAssets < 1) {
    console.warn(`⚠ maxAssets=${opts.maxAssets} is too low, using 1`)
    opts.maxAssets = 1
  }
  if (opts.concurrency < 1) {
    console.warn(`⚠ concurrency=${opts.concurrency} is too low, using 1`)
    opts.concurrency = 1
  }
  if (opts.timeout < 1000) {
    console.warn(`⚠ timeout=${opts.timeout}ms is very low, may cause failures`)
  }
  if (opts.retryInitialDelay !== undefined && opts.retryInitialDelay < 0) {
    console.warn(`⚠ retryInitialDelay=${opts.retryInitialDelay} is negative, using 0`)
    opts.retryInitialDelay = 0
  }
  if (opts.retryMaxDelay !== undefined && opts.retryMaxDelay < 0) {
    console.warn(`⚠ retryMaxDelay=${opts.retryMaxDelay} is negative, using 0`)
    opts.retryMaxDelay = 0
  }
  if ((opts.retryInitialDelay ?? 0) > (opts.retryMaxDelay ?? Infinity)) {
    console.warn(
      `⚠ retryInitialDelay=${opts.retryInitialDelay} > retryMaxDelay=${opts.retryMaxDelay}, clamping`
    )
    opts.retryMaxDelay = opts.retryInitialDelay
  }
  if (opts.mode !== "single" && opts.mode !== "bundle") {
    console.warn(`⚠ mode="${opts.mode}" is invalid, falling back to bundle`)
    opts.mode = "bundle"
  }
}

/**
 * Parse file-size strings like "50MB", "10m", or plain bytes.
 */
export function parseFileSize(val: string): number {
  const m = val.match(/^(\d+(?:\.\d+)?)\s*(k|m|g|kb|mb|gb)?$/i)
  if (!m) return parseInt(val, 10) || 0
  const num = parseFloat(m[1])
  const unit = (m[2] || "").toLowerCase()
  if (unit === "k" || unit === "kb") return Math.round(num * 1024)
  if (unit === "m" || unit === "mb") return Math.round(num * 1024 * 1024)
  if (unit === "g" || unit === "gb") return Math.round(num * 1024 * 1024 * 1024)
  return Math.round(num)
}
