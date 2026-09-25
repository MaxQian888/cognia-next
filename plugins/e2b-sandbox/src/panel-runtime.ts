/**
 * Bridge between `activate()` and the Context Workbench panel.
 *
 * A panel component receives only `{ workbenchInstanceId, resource, active }`
 * — the host owns its mount — so the pool and toast surface it needs have to
 * be parked somewhere both can reach. Module-level, cleared on deactivate so
 * a disabled plugin's panel cannot keep acting on live sandboxes.
 * (`plugins/sre-agent/src/panel-runtime.ts` precedent.)
 *
 * `subscribe`/`getVersion` are the panel's re-render signal: a stateful panel
 * stays mounted across activate/deactivate, so it subscribes here to notice
 * the runtime arriving or leaving, and to `pool.subscribe` for the rows.
 */

import type { PluginUIAPI } from "@cognia/plugin-sdk"
import type { E2BSandboxPool } from "./sandbox-pool"

export interface E2BConnectionStatus {
  /** Where sandbox API calls would go — the configured domain/apiUrl, or the E2B default. */
  endpoint: string
  /** "cloud" when no domain/apiUrl override is configured. */
  kind: "cloud" | "custom"
  /** Where the API key lives right now. */
  apiKey: "keyring" | "pending" | "missing"
}

export interface E2BPanelRuntime {
  pool: E2BSandboxPool
  /** Toast surface for release failures. */
  ui: Pick<PluginUIAPI, "showToast">
  /**
   * `isProvisioningAvailable()` at activation. While false the panel labels
   * workspace provisioning and the microVM tier as inactive (`provisioning.ts`).
   */
  provisioningAvailable: boolean
  getConnectionStatus: () => E2BConnectionStatus
}

let current: E2BPanelRuntime | null = null
let poolUnsubscribe: (() => void) | null = null
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A panel listener must never break lifecycle work.
    }
  }
}

export function setE2BPanelRuntime(next: E2BPanelRuntime): void {
  poolUnsubscribe?.()
  current = next
  // The bridge owns the pool→panel funnel: every pool mutation re-renders a
  // mounted panel, which then reads `pool.snapshot()` fresh. Whoever parks
  // the runtime (activate, tests) gets this for free.
  poolUnsubscribe = next.pool.subscribe(emit)
  emit()
}

export function clearE2BPanelRuntime(): void {
  poolUnsubscribe?.()
  poolUnsubscribe = null
  current = null
  emit()
}

export function peekE2BPanelRuntime(): E2BPanelRuntime | null {
  return current
}

/**
 * Re-render mounted panels — the connection snapshot changed but the runtime
 * object did not, so subscribers need an explicit nudge.
 */
export function notifyE2BPanelRuntime(): void {
  emit()
}

/** `useSyncExternalStore` subscribe — fires when the runtime is set/cleared. */
export function subscribeE2BPanelRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** `useSyncExternalStore` snapshot — monotonic, primitive, cache-safe. */
export function getE2BPanelRuntimeVersion(): number {
  return version
}
