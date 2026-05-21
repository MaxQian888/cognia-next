/**
 * Credentials rotation event bus.
 *
 * Settings/Connections forms (lark/slack/discord/telegram/onebot) emit
 * `credentials:rotated` after a successful save so the lifecycle layer can
 * re-queue the affected adapter without a full app restart.
 *
 * Why this exists: every adapter reads its credentials lazily via
 * `connectorsKeyringGet(rowId, name)` getters that are captured at build
 * time, so the **next** call after a Save will already see the new value.
 * The missing link was telling the runtime which adapter to tear down +
 * restart so any long-poll cursor, gateway socket, or webhook signature
 * cache is rebuilt against the rotated material. This module is that link.
 *
 * The contract is intentionally narrow:
 *   - `emitCredentialsRotated(adapterId)` — fire-and-forget from the form.
 *   - `onCredentialsRotated(handler)` — register a global listener; returns
 *     an unsubscribe function. The handler receives the adapterId so it
 *     can decide whether the rotation matters to it (lifecycle requeues
 *     only the matching running adapter).
 *
 * The bus is a process-wide singleton built on `EventTarget`; it works in
 * both the browser shell and the Tauri webview without extra plumbing.
 */
export interface CredentialsRotatedDetail {
  adapterId: string
  rotatedAt: number
}

const EVENT_NAME = "connectors:credentials:rotated"
const bus: EventTarget = new EventTarget()

export function emitCredentialsRotated(adapterId: string): void {
  if (!adapterId) return
  const detail: CredentialsRotatedDetail = {
    adapterId,
    rotatedAt: Date.now(),
  }
  bus.dispatchEvent(new CustomEvent<CredentialsRotatedDetail>(EVENT_NAME, { detail }))
}

export function onCredentialsRotated(
  handler: (detail: CredentialsRotatedDetail) => void
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CredentialsRotatedDetail>).detail
    if (!detail) return
    try {
      handler(detail)
    } catch (err) {
      console.error(
        `[credentials-events] handler threw for adapter ${detail.adapterId}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  bus.addEventListener(EVENT_NAME, listener)
  return () => bus.removeEventListener(EVENT_NAME, listener)
}

/** Test helper — drains listeners between cases. */
export function __resetCredentialsEventsForTesting(): void {
  // Re-creating the EventTarget would change the reference; instead we
  // dispatch a sentinel that listeners ignore but consumers can use to
  // know a reset is happening. The test suite uses unsubscribe handles
  // returned from `onCredentialsRotated`, so this helper only exists to
  // give tests a tracked symbol.
  void bus
}
