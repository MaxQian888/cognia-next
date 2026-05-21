/**
 * Plugin Consent Broker (TS-side).
 *
 * Per-call consent flow for `PermissionGuard` tier `"confirm"`. Mirrors
 * the protocol from `src-tauri/src/automation/consent.rs` but stays
 * fully inside the renderer because plugin API calls already run in
 * the same JS runtime as the overlay.
 *
 * Flow:
 *
 *   1. A guarded plugin API call resolves the configured tier; if
 *      `"confirm"`, the API path calls `requestConsent({ pluginId,
 *      permission, reason })`.
 *   2. `requestConsent` checks the per-session grant cache. If the user
 *      previously chose "Always allow this session" for that
 *      `(pluginId, permission)` tuple, it resolves `true` immediately.
 *   3. Otherwise it generates a `requestId`, stores the resolver,
 *      dispatches a `plugin:consent-request` CustomEvent on window
 *      with `{ requestId, pluginId, permission, reason, timeoutMs }`,
 *      then awaits the resolver with a 30 s timeout (auto-reject).
 *   4. The overlay component (`components/plugins/plugin-consent-overlay.tsx`)
 *      listens for the event and renders "Allow once / Always allow
 *      this session / Reject". On click it calls
 *      `respondConsent(requestId, { allow, persist })`.
 *   5. `respondConsent` resolves the matching Promise and, when
 *      `persist === true && allow === true`, adds an entry to the
 *      session grant cache so future calls skip the overlay.
 *
 * Session grants are in-memory; cleared on killswitch, plugin
 * disable / unload, and full app reload.
 */

import type { PluginPermission } from "@/types/plugin"

export interface PluginConsentRequest {
  pluginId: string
  permission: PluginPermission
  /** Optional reason string supplied by the calling site. */
  reason?: string
}

export interface PluginConsentResponse {
  allow: boolean
  /** True when the user chose "Always allow this session". */
  persist: boolean
}

export interface PluginConsentRequestEvent extends PluginConsentRequest {
  requestId: string
  timeoutMs: number
}

/** Default time a request waits before auto-rejecting. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 30_000

/** Event name used to ferry requests to the renderer-side overlay. */
export const PLUGIN_CONSENT_REQUEST_EVENT = "plugin:consent-request"

type Resolver = (value: boolean) => void

interface BrokerOptions {
  timeoutMs?: number
  /**
   * Custom event emitter — defaults to `window.dispatchEvent` when
   * available. Tests override this to capture the dispatched events
   * without needing a JSDOM window.
   */
  emit?: (event: PluginConsentRequestEvent) => void
}

export class PluginConsentBroker {
  private readonly pending = new Map<
    string,
    {
      resolve: Resolver
      pluginId: string
      permission: PluginPermission
      timeoutHandle: ReturnType<typeof setTimeout>
    }
  >()
  private readonly sessionGrants = new Set<string>()
  private readonly timeoutMs: number
  private readonly emit: (event: PluginConsentRequestEvent) => void

  constructor(options: BrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS
    this.emit =
      options.emit ??
      ((event) => {
        if (typeof window === "undefined") return
        window.dispatchEvent(new CustomEvent(PLUGIN_CONSENT_REQUEST_EVENT, { detail: event }))
      })
  }

  /**
   * Public entry point. Resolves `true` if the call is allowed (either
   * via existing session grant or user response), `false` otherwise.
   * Never rejects — the caller can rely on the boolean.
   */
  async request(req: PluginConsentRequest): Promise<boolean> {
    if (this.hasSessionGrant(req.pluginId, req.permission)) return true
    const requestId = generateRequestId()
    return new Promise<boolean>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        const row = this.pending.get(requestId)
        if (row) {
          this.pending.delete(requestId)
          row.resolve(false)
        }
      }, this.timeoutMs)
      this.pending.set(requestId, {
        resolve,
        pluginId: req.pluginId,
        permission: req.permission,
        timeoutHandle,
      })
      try {
        this.emit({
          requestId,
          pluginId: req.pluginId,
          permission: req.permission,
          reason: req.reason,
          timeoutMs: this.timeoutMs,
        })
      } catch {
        // Emit failed — auto-reject so the caller doesn't hang.
        this.pending.delete(requestId)
        clearTimeout(timeoutHandle)
        resolve(false)
      }
    })
  }

  /**
   * Resolve a pending request. Idempotent — repeated calls with the
   * same `requestId` after the first response are silently dropped so
   * a double-click on the overlay can't corrupt the broker.
   */
  respond(requestId: string, response: PluginConsentResponse): boolean {
    const row = this.pending.get(requestId)
    if (!row) return false
    this.pending.delete(requestId)
    clearTimeout(row.timeoutHandle)
    if (response.allow && response.persist) {
      this.sessionGrants.add(sessionKey(row.pluginId, row.permission))
    }
    row.resolve(response.allow)
    return true
  }

  hasSessionGrant(pluginId: string, permission: PluginPermission): boolean {
    return this.sessionGrants.has(sessionKey(pluginId, permission))
  }

  /** Drop every grant — used by the kill switch / app reload. */
  clearAllSessionGrants(): void {
    this.sessionGrants.clear()
  }

  /** Drop grants for a single plugin — used by plugin disable / unload. */
  clearSessionGrantsForPlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.sessionGrants]) {
      if (key.startsWith(prefix)) this.sessionGrants.delete(key)
    }
  }

  /** Reject every pending request — used during teardown. */
  rejectAllPending(): void {
    for (const [, row] of this.pending) {
      clearTimeout(row.timeoutHandle)
      row.resolve(false)
    }
    this.pending.clear()
  }

  /** Test introspection — number of currently pending requests. */
  pendingCount(): number {
    return this.pending.size
  }
}

function sessionKey(pluginId: string, permission: PluginPermission): string {
  return `${pluginId}:${permission}`
}

function generateRequestId(): string {
  // `crypto.randomUUID` is available in Node 19+ and every browser the
  // host targets. Fallback keeps the broker usable in older test envs.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `consent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// =============================================================================
// Singleton
// =============================================================================

let instance: PluginConsentBroker | null = null

export function getPluginConsentBroker(): PluginConsentBroker {
  if (!instance) instance = new PluginConsentBroker()
  return instance
}

export function resetPluginConsentBroker(): void {
  if (instance) {
    instance.rejectAllPending()
    instance.clearAllSessionGrants()
    instance = null
  }
}
