/**
 * The one constructor for {@link CogniaDiagnostic}.
 *
 * Producers state *what happened* (a code, where it came from, the raw text)
 * and this fills in what that means by consulting {@link DIAGNOSTIC_CODES}.
 * Keeping construction in one function is what stops the registry's severity /
 * retryability decisions from being quietly re-litigated at each call site.
 */

import { DIAGNOSTIC_CODES } from "./registry"
import type {
  CogniaDiagnostic,
  DiagnosticAction,
  DiagnosticCode,
  DiagnosticMeta,
  DiagnosticSeverity,
  DiagnosticSource,
} from "./types"

export interface CreateDiagnosticInit {
  source: DiagnosticSource
  /** Raw technical text. Never user-facing prose — the code owns the label. */
  message?: string
  meta?: DiagnosticMeta
  /** Stack trace or raw payload for the "show raw" disclosure. */
  detail?: string
  /** Appended after the registry defaults, deduped. */
  actions?: readonly DiagnosticAction[]
  /** Override the registry severity. Rare — prefer a more specific code. */
  severity?: DiagnosticSeverity
  /** Override the registry retryability. Rare; the Rust side does use it. */
  retryable?: boolean
  /** Override whether this is a lasting condition rather than an event. */
  persistent?: boolean
  /** Injected clock, so tests can assert on whole diagnostics with `toEqual`. */
  now?: () => number
  /** Injected id, same reason. */
  id?: string
}

/**
 * Monotonic tiebreaker. Two failures inside the same millisecond are common
 * (a fan-out of parallel tool calls all rejecting at once) and they must not
 * collapse onto one id, or dedupe would swallow real, distinct diagnostics.
 */
let sequence = 0

function nextId(code: DiagnosticCode, at: number): string {
  sequence += 1
  return `${code}-${at}-${sequence}`
}

/** Stable identity for an action, so defaults and extras dedupe correctly. */
function actionKey(action: DiagnosticAction): string {
  // Payload is part of the key: two `open-settings` actions pointing at
  // different panes are genuinely different affordances.
  const { kind, ...payload } = action as { kind: string } & Record<string, unknown>
  const entries = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))
  return entries.length === 0 ? kind : `${kind}:${JSON.stringify(entries)}`
}

function dedupeActions(actions: readonly DiagnosticAction[]): DiagnosticAction[] {
  const seen = new Set<string>()
  const out: DiagnosticAction[] = []
  for (const action of actions) {
    const key = actionKey(action)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(action)
  }
  return out
}

/**
 * Swap a plain retry for a countdown when the provider told us how long to
 * wait. Applied centrally so no producer has to remember it, and so a
 * `Retry-After` that the sidecar already parsed stops being discarded on the
 * way to the button.
 */
function applyRetryAfter(
  actions: readonly DiagnosticAction[],
  retryAfterMs: number | undefined
): readonly DiagnosticAction[] {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return actions
  if (actions.some((a) => a.kind === "wait-and-retry")) return actions
  if (!actions.some((a) => a.kind === "retry")) return actions
  return actions.map((a) => (a.kind === "retry" ? { kind: "wait-and-retry", retryAfterMs } : a))
}

export function createDiagnostic(
  code: DiagnosticCode,
  init: CreateDiagnosticInit
): CogniaDiagnostic {
  const spec = DIAGNOSTIC_CODES[code]
  const at = (init.now ?? Date.now)()
  const actions = applyRetryAfter(
    dedupeActions([...spec.actions, ...(init.actions ?? [])]),
    init.meta?.retryAfterMs
  )

  return {
    id: init.id ?? nextId(code, at),
    at,
    code,
    severity: init.severity ?? spec.severity,
    retryable: init.retryable ?? spec.retryable,
    persistent: init.persistent ?? spec.persistent,
    source: init.source,
    message: init.message ?? "",
    actions,
    ...(init.meta ? { meta: init.meta } : {}),
    ...(init.detail ? { detail: init.detail } : {}),
  }
}

/** Test-only: make generated ids deterministic across suites. */
export function __resetDiagnosticSequenceForTesting(): void {
  sequence = 0
}
