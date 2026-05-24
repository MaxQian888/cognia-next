import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { redactText } from "@/lib/twin/ingest/redact"

/**
 * Frontend → Rust crash-context bridge. The renderer pushes a **redacted**
 * config snapshot and breadcrumbs so a later Rust panic or native crash report
 * includes "what the user was doing" (ADR — crash-report subsystem). The Rust
 * side folds this into both the in-process panic report and the out-of-process
 * native-crash report.
 *
 * Secrets/PII are the red line: every string value is run through
 * `redactText` (`lib/twin/ingest/redact.ts`) before it crosses the boundary,
 * so even an accidental token in a config field is scrubbed.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Deep-redact every string value in a JSON-shaped config object. */
export function redactConfig(value: unknown): Json {
  if (typeof value === "string") {
    return redactText(value).redacted
  }
  if (Array.isArray(value)) {
    return value.map(redactConfig)
  }
  if (value && typeof value === "object") {
    const out: { [key: string]: Json } = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactConfig(val)
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
