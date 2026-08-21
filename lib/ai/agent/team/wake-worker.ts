"use client"

import { RemoteWorkerWaitingError } from "./remote-worker-runtime"

/**
 * Try to wake a worker host that placement just rejected as offline.
 *
 * "Offline" and "asleep" look identical from here — the socket is gone either
 * way — but only one of them is permanent. Without this, a sleeping machine
 * stays offline forever: placement refuses it, the run waits, nobody wakes it.
 *
 * This is a hint, not a transport. It can only work when the host is on the
 * same broadcast domain, the worker advertised a MAC in its manifest, and
 * Wake-on-LAN is enabled in that machine's firmware. A `false` result means the
 * attempt was not made; nothing here promises the machine came back.
 */

export interface WakeWorkerOptions {
  tenantId: string
  hostRef: string
  invoke?: <T>(command: string, args: Record<string, unknown>) => Promise<T>
}

/** Reasons a wake is worth attempting — the worker is absent, not incompatible. */
const WAKEABLE_REASONS = new Set(["pinned_host_offline", "no_compatible_capacity"])

export function shouldAttemptWake(error: unknown): error is RemoteWorkerWaitingError {
  return error instanceof RemoteWorkerWaitingError && WAKEABLE_REASONS.has(error.reason)
}

export async function requestWorkerWake(options: WakeWorkerOptions): Promise<boolean> {
  if (!options.hostRef) return false
  try {
    const invoke = options.invoke ?? (await import("@tauri-apps/api/core")).invoke
    return await invoke<boolean>("companion_wake_worker", {
      tenantId: options.tenantId,
      hostRef: options.hostRef,
    })
  } catch {
    // Not a Tauri host, no presence record, or no route — all of which mean
    // "cannot wake this one", never "fail the dispatch".
    return false
  }
}
