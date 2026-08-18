/**
 * Host → thin-client sync invalidation (ADR-0131 cross-shell inbox relay).
 *
 * The connector host writes `messages` / `outboundQueue` / `connectorDrafts`
 * / `conversationOverrides` many times per second under load (an ai-run
 * reply alone touches the outbound row three times). Companion clients only
 * need to learn "table X changed — pull it", so this module coalesces bursts
 * into one `sync://invalidate { table, conversationKey? }` frame per table
 * per {@link INVALIDATE_COALESCE_MS} window before handing it to
 * {@link publishHostEvent} (Tauri emit on the desktop, bridge RPC on the
 * headless brain, no-op elsewhere).
 *
 * `conversationKey` rides along only when EVERY write in the window targeted
 * the same conversation; a mixed burst drops it so the client does one
 * table-wide pull instead of N keyed ones. The client side
 * (`lib/sync/companion-sync.ts:installEventDrivenSync`) coalesces again at
 * 100 ms per table, so a chatty host still yields one `sync_pull` per table.
 *
 * Skipped entirely while THIS desktop is itself a thin client of a remote
 * host (`isRemoteHostActive()`): its Dexie writes are mirrors of the remote
 * host's rows, not authoritative, and its own paired phones must not be told
 * to re-pull them from here.
 */

import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import type { SyncableTable } from "./types"

export const SYNC_INVALIDATE_TOPIC = "sync://invalidate"
export const INVALIDATE_COALESCE_MS = 150

export interface SyncInvalidatePayload {
  table: SyncableTable
  conversationKey?: string
}

interface PendingInvalidate {
  timer: ReturnType<typeof setTimeout>
  /** `undefined` = no key seen yet; `null` = mixed keys (send table-wide). */
  conversationKey: string | null | undefined
}

const pending = new Map<SyncableTable, PendingInvalidate>()

/** Injectable seams for tests (clock + publisher). */
export interface HostInvalidateDeps {
  publish?: (topic: string, payload: SyncInvalidatePayload) => void | Promise<void>
  setTimeoutFn?: typeof setTimeout
  isRemoteHostActiveFn?: () => boolean
}

let deps: Required<HostInvalidateDeps> = {
  publish: publishHostEvent,
  setTimeoutFn: setTimeout,
  isRemoteHostActiveFn: isRemoteHostActive,
}

/** Test seam — swap the publisher / clock; returns a restore function. */
export function __setHostInvalidateDepsForTests(next: HostInvalidateDeps): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

/**
 * Schedule a coalesced `sync://invalidate` for `table`. Synchronous and
 * never throws — safe to call from any Dexie writer without awaiting.
 */
export function publishSyncInvalidate(table: SyncableTable, conversationKey?: string): void {
  try {
    if (deps.isRemoteHostActiveFn()) return
  } catch {
    // Routing module unavailable (SSR) — treat as local host.
  }
  const existing = pending.get(table)
  if (existing) {
    if (existing.conversationKey === undefined) {
      existing.conversationKey = conversationKey ?? null
    } else if (existing.conversationKey !== null && existing.conversationKey !== conversationKey) {
      existing.conversationKey = null
    }
    return
  }
  const entry: PendingInvalidate = {
    timer: deps.setTimeoutFn(() => flush(table), INVALIDATE_COALESCE_MS),
    conversationKey: conversationKey ?? null,
  }
  pending.set(table, entry)
}

function flush(table: SyncableTable): void {
  const entry = pending.get(table)
  pending.delete(table)
  if (!entry) return
  const payload: SyncInvalidatePayload =
    entry.conversationKey === null || entry.conversationKey === undefined
      ? { table }
      : { table, conversationKey: entry.conversationKey }
  try {
    const result = deps.publish(SYNC_INVALIDATE_TOPIC, payload)
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => undefined)
    }
  } catch {
    // Best-effort — see module doc.
  }
}

/**
 * Flush every pending window immediately (host teardown / tests). Publishes
 * whatever was coalesced so a client is not left one pull behind.
 */
export function flushPendingSyncInvalidates(): void {
  for (const [table, entry] of Array.from(pending.entries())) {
    clearTimeout(entry.timer)
    flush(table)
  }
}

/** Test-only: drop pending windows without publishing. */
export function __resetHostInvalidateForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}
