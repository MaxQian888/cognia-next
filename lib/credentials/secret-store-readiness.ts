/**
 * Renderer half of the encrypted secret store's readiness
 * (`cognia_secrets::secret_store`, Rust).
 *
 * The native store resolves its master key from the OS keychain once per
 * process. A caller that arrives while that happens waits natively; a failed
 * attempt (keychain locked, access denied or cancelled) is cached as a typed
 * error until the user explicitly retries. Every native error carries a stable
 * code — `SECRET_STORE_LOCKED` or `SECRET_STORE_INITIALIZING` — even when a
 * command wraps it in its own message.
 *
 * This module is the single renderer sink for those failures:
 *
 * - {@link classifySecretStoreError} recognises the codes in any IPC rejection
 *   shape (bare string, `Error`, plugin-gateway `UNAVAILABLE`).
 * - {@link reportSecretStoreFailure} records the state and logs **once per
 *   locked episode**, instead of one console line (or unhandled rejection) per
 *   consumer.
 * - The recovery boot gate reads the native state at cold boot, surfaces the
 *   Retry, and publishes the outcome with {@link setSecretStoreReadiness}.
 * - When the store transitions from unavailable to ready, deferred consumers
 *   ({@link deferUntilSecretStoreReady}) and recovery listeners
 *   ({@link onSecretStoreRecovered}) re-run.
 */

import { loggers } from "@cognia/logging"

export const SECRET_STORE_LOCKED_CODE = "SECRET_STORE_LOCKED"
export const SECRET_STORE_INITIALIZING_CODE = "SECRET_STORE_INITIALIZING"

/** Mirrors the native `Readiness` enum (kebab-case on the wire). */
export type SecretStoreReadiness = "uninitialized" | "initializing" | "ready" | "locked"

/** Why a call failed: transient (`initializing`) or terminal until retry (`locked`). */
export type SecretStoreUnavailableReason = "locked" | "initializing"

const READINESS_VALUES: readonly SecretStoreReadiness[] = [
  "uninitialized",
  "initializing",
  "ready",
  "locked",
]

export function isSecretStoreReadiness(value: unknown): value is SecretStoreReadiness {
  return typeof value === "string" && (READINESS_VALUES as readonly string[]).includes(value)
}

/**
 * Typed replacement for a raw IPC rejection string. Thrown by renderer
 * wrappers so callers can branch on `code` instead of parsing messages.
 */
export class SecretStoreUnavailableError extends Error {
  readonly code: typeof SECRET_STORE_LOCKED_CODE | typeof SECRET_STORE_INITIALIZING_CODE
  readonly reason: SecretStoreUnavailableReason

  constructor(reason: SecretStoreUnavailableReason, options: { cause?: unknown } = {}) {
    const code = reason === "locked" ? SECRET_STORE_LOCKED_CODE : SECRET_STORE_INITIALIZING_CODE
    super(
      reason === "locked"
        ? `${code}: secure storage is locked until the system keychain is unlocked`
        : `${code}: secure storage is still initializing`,
      { cause: options.cause }
    )
    this.name = "SecretStoreUnavailableError"
    this.code = code
    this.reason = reason
  }
}

function reasonFromText(text: string): SecretStoreUnavailableReason | null {
  if (text.includes(SECRET_STORE_LOCKED_CODE)) return "locked"
  if (text.includes(SECRET_STORE_INITIALIZING_CODE)) return "initializing"
  return null
}

/**
 * Recognise a secret-store readiness failure in any rejection shape the
 * renderer sees. `null` for every other error, so callers keep their normal
 * handling for real per-entry failures.
 */
export function classifySecretStoreError(error: unknown): SecretStoreUnavailableReason | null {
  if (error instanceof SecretStoreUnavailableError) return error.reason
  if (typeof error === "string") return reasonFromText(error)
  if (typeof error !== "object" || error === null) return null
  const record = error as { code?: unknown; details?: unknown; message?: unknown }
  // Plugin gateway: `{ code: "UNAVAILABLE", details: { reason: "SECRET_STORE_LOCKED" } }`.
  if (record.code === "UNAVAILABLE" && typeof record.details === "object" && record.details) {
    const reason = (record.details as { reason?: unknown }).reason
    if (typeof reason === "string") {
      const classified = reasonFromText(reason)
      if (classified) return classified
    }
  }
  if (typeof record.code === "string") {
    const classified = reasonFromText(record.code)
    if (classified) return classified
  }
  return typeof record.message === "string" ? reasonFromText(record.message) : null
}

/** Wrap a readiness failure as {@link SecretStoreUnavailableError}; `null` otherwise. */
export function toSecretStoreUnavailableError(error: unknown): SecretStoreUnavailableError | null {
  if (error instanceof SecretStoreUnavailableError) return error
  const reason = classifySecretStoreError(error)
  return reason ? new SecretStoreUnavailableError(reason, { cause: error }) : null
}

// ── State ───────────────────────────────────────────────────────────────────

let readiness: SecretStoreReadiness = "uninitialized"
/** Consumers that reported a failure this episode, for the single log line. */
const episodeSources = new Set<string>()
let episodeLogged = false
const stateListeners = new Set<(state: SecretStoreReadiness) => void>()
const recoveryListeners = new Set<() => void | Promise<void>>()
const deferred = new Map<string, () => void | Promise<void>>()

export function getSecretStoreReadiness(): SecretStoreReadiness {
  return readiness
}

/** Subscribe to state changes (e.g. `useSyncExternalStore`). */
export function subscribeSecretStoreReadiness(
  listener: (state: SecretStoreReadiness) => void
): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/**
 * Register a listener that runs every time the store recovers — i.e. moves to
 * `ready` after having been observed `locked` or `initializing`. Use it for
 * idempotent re-application (re-pushing native policy). Never fires for the
 * first, healthy boot: consumers already ran against a ready store.
 */
export function onSecretStoreRecovered(listener: () => void | Promise<void>): () => void {
  recoveryListeners.add(listener)
  return () => {
    recoveryListeners.delete(listener)
  }
}

/**
 * Queue a one-shot re-run for a consumer whose work failed because the store
 * was unavailable. Keyed, so a consumer that fails repeatedly re-runs once.
 * Runs immediately (on a microtask) when the store is already ready.
 */
export function deferUntilSecretStoreReady(key: string, run: () => void | Promise<void>): void {
  if (readiness === "ready") {
    void invokeSafely(key, run)
    return
  }
  deferred.set(key, run)
}

async function invokeSafely(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    // A re-run failing must not stop the others; the consumer owns its error.
    loggers.auth.warn("Deferred secret-store consumer failed after unlock", {
      consumer: label,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function emitState(): void {
  for (const listener of stateListeners) {
    try {
      listener(readiness)
    } catch {
      // A broken subscriber must not break readiness propagation.
    }
  }
}

/**
 * Publish the authoritative native state (boot answer, retry outcome). A
 * transition from unavailable to `ready` re-runs recovery listeners and every
 * deferred consumer.
 */
export function setSecretStoreReadiness(next: SecretStoreReadiness): void {
  const previous = readiness
  if (previous === next) return
  readiness = next
  emitState()
  if (next !== "ready") return
  const recovered = previous === "locked" || previous === "initializing"
  episodeSources.clear()
  episodeLogged = false
  const pending = [...deferred.entries()]
  deferred.clear()
  if (!recovered && pending.length === 0) return
  if (recovered) {
    loggers.auth.info("Secure storage unlocked; re-running deferred consumers", {
      deferred: pending.map(([key]) => key),
    })
    for (const listener of [...recoveryListeners]) void invokeSafely("recovery-listener", listener)
  }
  for (const [key, run] of pending) void invokeSafely(key, run)
}

/**
 * Record a consumer's failure. Returns `true` when `error` was a readiness
 * failure (the caller should treat it as "store unavailable", not as a broken
 * entry) and `false` otherwise. Logs once per locked episode, naming the
 * consumers seen so far, so one locked keychain is one log line.
 */
export function reportSecretStoreFailure(error: unknown, source: string): boolean {
  const reason = classifySecretStoreError(error)
  if (!reason) return false
  episodeSources.add(source)
  if (reason === "locked") {
    if (readiness !== "locked") {
      readiness = "locked"
      emitState()
    }
    if (!episodeLogged) {
      episodeLogged = true
      loggers.auth.warn(
        "Secure storage is locked; credential consumers are deferred until it is unlocked",
        { firstConsumer: source }
      )
    } else {
      loggers.auth.debug("Secure storage still locked", { consumer: source })
    }
  } else if (readiness !== "locked" && readiness !== "initializing") {
    // Transient: the native wait budget ran out. Never downgrades `locked`.
    readiness = "initializing"
    emitState()
    loggers.auth.debug("Secure storage still initializing", { consumer: source })
  }
  return true
}

/** Consumers that reported a failure in the current episode (diagnostics/tests). */
export function getSecretStoreFailureSources(): string[] {
  return [...episodeSources]
}

/** Test-only: reset module state between cases. */
export function __resetSecretStoreReadinessForTesting(): void {
  readiness = "uninitialized"
  episodeSources.clear()
  episodeLogged = false
  stateListeners.clear()
  recoveryListeners.clear()
  deferred.clear()
}
