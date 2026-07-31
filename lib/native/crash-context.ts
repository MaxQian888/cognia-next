import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { redactText } from "@cognia/redact"
import {
  DEFAULT_REDACTION_KEYS,
  DEFAULT_REDACTION_PATTERNS,
  DEFAULT_REDACTION_REPLACEMENT,
} from "@cognia/logging/redaction-patterns"

/**
 * Frontend → Rust crash-context bridge. The renderer pushes a **redacted**
 * config snapshot and breadcrumbs so a later Rust panic or native crash report
 * includes "what the user was doing" (ADR — crash-report subsystem). The Rust
 * side folds this into both the in-process panic report and the out-of-process
 * native-crash report.
 *
 * Secrets/PII are the red line: every string value is run through
 * `redactText` (`packages/redact/src/index.ts`) before it crosses the boundary,
 * so even an accidental token in a config field is scrubbed.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const SENSITIVE_CONFIG_KEYS = new Set(DEFAULT_REDACTION_KEYS.map((key) => normalizeKey(key)))

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return [...SENSITIVE_CONFIG_KEYS].some(
    (candidate) => normalized === candidate || normalized.includes(candidate)
  )
}

function redactSharedPatterns(value: string): string {
  return DEFAULT_REDACTION_PATTERNS.reduce((current, pattern) => {
    try {
      return current.replace(new RegExp(pattern, "gi"), DEFAULT_REDACTION_REPLACEMENT)
    } catch {
      return current
    }
  }, value)
}

/** Deep-redact every string value in a JSON-shaped config object. */
export function redactConfig(value: unknown, keyHint?: string): Json {
  if (typeof value === "string") {
    const redacted = redactSharedPatterns(redactText(value).redacted)
    if (redacted !== value) return redacted
    return keyHint && shouldRedactKey(keyHint) ? DEFAULT_REDACTION_REPLACEMENT : redacted
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactConfig(item))
  }
  if (value && typeof value === "object") {
    const out: { [key: string]: Json } = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactConfig(val, key)
    }
    return out
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value
  }
  // Drop anything non-serializable (functions, symbols, undefined).
  return null
}

/** Push a redacted config snapshot. No-op off the desktop runtime. */
export async function pushCrashContext(config: Record<string, unknown>): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke("crash_set_context", { config: redactConfig(config) })
  } catch {
    // Best-effort — never let diagnostics wiring break the app.
  }
}

/** Append a breadcrumb (recent user action / app event). No-op off desktop. */
export async function pushCrashBreadcrumb(message: string, level = "info"): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke("crash_push_breadcrumb", { message: redactText(message).redacted, level })
  } catch {
    // Best-effort.
  }
}
