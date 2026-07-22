/**
 * Remote Control Store
 *
 * Zustand cache for the remote-control settings UI. The actual durable
 * source of truth for the inbound listener lives in Rust (axum thread +
 * `tauri-plugin-store`), so this store's job is:
 *   1. Snappy first paint of the settings page (persist via localStorage).
 *   2. Mirror UI mutations down to Rust through the Tauri commands in
 *      `lib/tauri/remote-control.ts`.
 *   3. Hold a small ring buffer of recent inbound calls fed by the
 *      `RemoteControlReceiver` provider so the Overview tab can render.
 *
 * Token + signing secret never live here — they're in the OS keyring on
 * desktop, accessed through `remoteControlGetToken` /
 * `remoteControlGetSigningSecret` on demand.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import {
  remoteControlGetStatus,
  remoteControlSetSigningSecret,
  remoteControlStart,
  remoteControlStop,
  remoteControlUpdateConfig,
} from "@/lib/tauri/remote-control"
import {
  DEFAULT_REMOTE_CONTROL_CONFIG,
  REMOTE_CONTROL_RECENT_CALLS_LIMIT,
  type RemoteControlConfig,
  type RemoteControlInboundCallLog,
  type RemoteControlOutboundHeader,
  type RemoteControlStatus,
} from "@/types/remote-control"

const log = loggers.scheduler

interface RemoteControlState {
  config: RemoteControlConfig
  status: RemoteControlStatus
  recentCalls: RemoteControlInboundCallLog[]
  isHydrating: boolean
  lastError: string | null
}

interface RemoteControlActions {
  /** Pull live status + persisted config from Rust (no-op on web). */
  hydrate: () => Promise<void>

  /** Mutate inbound config and push to Rust if available. */
  updateInbound: (
    patch: Partial<RemoteControlConfig["inbound"]>
  ) => Promise<{ ok: boolean; error?: string }>

  /** Mutate outbound config and push to Rust if available. */
  updateOutbound: (
    patch: Partial<RemoteControlConfig["outbound"]>
  ) => Promise<{ ok: boolean; error?: string }>

  /** Replace the custom-headers list. */
  setOutboundHeaders: (
    headers: RemoteControlOutboundHeader[]
  ) => Promise<{ ok: boolean; error?: string }>

  /** Start / stop the inbound listener (desktop only). */
  startInbound: () => Promise<{ ok: boolean; error?: string }>
  stopInbound: () => Promise<{ ok: boolean; error?: string }>

  /** Set / clear the signing secret. Updates `hasSigningSecret` mirror. */
  setSigningSecret: (secret: string | null) => Promise<{ ok: boolean; error?: string }>

  /** Append an entry to the inbound-call ring buffer (capped). */
  recordInboundCall: (entry: RemoteControlInboundCallLog) => void

  /** Reset to factory defaults. Used by tests + the "reset" CTA. */
  reset: () => void
}

type RemoteControlStore = RemoteControlState & RemoteControlActions

const initialStatus: RemoteControlStatus = {
  inboundRunning: false,
  boundPort: null,
  lastCallAt: null,
  inboundCallsTotal: 0,
  hasInboundToken: false,
}

const initialState: RemoteControlState = {
  config: cloneConfig(DEFAULT_REMOTE_CONTROL_CONFIG),
  status: initialStatus,
  recentCalls: [],
  isHydrating: false,
  lastError: null,
}

function cloneConfig(c: RemoteControlConfig): RemoteControlConfig {
  return {
    inbound: {
      ...c.inbound,
      allowlist: [...c.inbound.allowlist],
      disabledTargets: [...(c.inbound.disabledTargets ?? [])],
    },
    outbound: {
      hasSigningSecret: c.outbound.hasSigningSecret,
      defaultHeaders: c.outbound.defaultHeaders.map((h) => ({ ...h })),
      endpoints: (c.outbound.endpoints ?? []).map((e) => ({
        ...e,
        headers: e.headers.map((h) => ({ ...h })),
        eventTypes: e.eventTypes ? [...e.eventTypes] : undefined,
      })),
      delivery: c.outbound.delivery ? { ...c.outbound.delivery } : undefined,
    },
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const useRemoteControlStore = create<RemoteControlStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      hydrate: async () => {
        if (!isTauri()) return
        if (get().isHydrating) return
        set({ isHydrating: true, lastError: null })
        try {
          const status = await remoteControlGetStatus()
          // Defensive: a misconfigured Tauri mock (or a Rust-side regression)
          // can resolve with undefined; preserve the previous status rather
          // than wiping it out.
          if (status) set({ status })
        } catch (error) {
          const message = describeError(error)
          log.warn("remoteControl.hydrate failed", { error: message })
          set({ lastError: message })
        } finally {
          set({ isHydrating: false })
        }
      },

      updateInbound: async (patch) => {
        const next = cloneConfig(get().config)
        next.inbound = { ...next.inbound, ...patch }
        if (Array.isArray(patch.allowlist)) {
          next.inbound.allowlist = [...patch.allowlist]
        }
        if (Array.isArray(patch.disabledTargets)) {
          next.inbound.disabledTargets = [...patch.disabledTargets]
        }
        set({ config: next })
        if (!isTauri()) return { ok: true }
        try {
          await remoteControlUpdateConfig(next)
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("remoteControl.updateInbound failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      updateOutbound: async (patch) => {
        const next = cloneConfig(get().config)
        next.outbound = { ...next.outbound, ...patch }
        if (Array.isArray(patch.defaultHeaders)) {
          next.outbound.defaultHeaders = patch.defaultHeaders.map((h) => ({ ...h }))
        }
        if (Array.isArray(patch.endpoints)) {
          next.outbound.endpoints = patch.endpoints.map((e) => ({
            ...e,
            headers: e.headers.map((h) => ({ ...h })),
            eventTypes: e.eventTypes ? [...e.eventTypes] : undefined,
          }))
        }
        if (patch.delivery) {
          next.outbound.delivery = { ...patch.delivery }
        }
        set({ config: next })
        if (!isTauri()) return { ok: true }
        try {
          await remoteControlUpdateConfig(next)
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("remoteControl.updateOutbound failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      setOutboundHeaders: async (headers) => {
        return get().updateOutbound({ defaultHeaders: headers })
      },

      startInbound: async () => {
        if (!isTauri()) {
          return { ok: false, error: "remote_control_start requires the Tauri desktop runtime" }
        }
        try {
          await remoteControlStart()
          await get().hydrate()
          set((s) => ({ config: { ...s.config, inbound: { ...s.config.inbound, enabled: true } } }))
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("remoteControl.startInbound failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      stopInbound: async () => {
        if (!isTauri()) {
          return { ok: false, error: "remote_control_stop requires the Tauri desktop runtime" }
        }
        try {
          await remoteControlStop()
          await get().hydrate()
          set((s) => ({
            config: { ...s.config, inbound: { ...s.config.inbound, enabled: false } },
          }))
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("remoteControl.stopInbound failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      setSigningSecret: async (secret) => {
        // Update mirror immediately so the UI reflects the change without
        // waiting for a status round-trip.
        set((s) => ({
          config: {
            ...s.config,
            outbound: { ...s.config.outbound, hasSigningSecret: secret !== null && secret !== "" },
          },
        }))
        if (!isTauri()) return { ok: true }
        try {
          await remoteControlSetSigningSecret(secret && secret.length > 0 ? secret : null)
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("remoteControl.setSigningSecret failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      recordInboundCall: (entry) => {
        set((s) => {
          const next = [entry, ...s.recentCalls].slice(0, REMOTE_CONTROL_RECENT_CALLS_LIMIT)
          return {
            recentCalls: next,
            status: {
              ...s.status,
              inboundCallsTotal: s.status.inboundCallsTotal + 1,
              lastCallAt: entry.at,
            },
          }
        })
      },

      reset: () => {
        set({
          ...initialState,
          config: cloneConfig(DEFAULT_REMOTE_CONTROL_CONFIG),
          status: { ...initialStatus },
          recentCalls: [],
        })
      },
    }),
    {
      name: "cognia-remote-control",
      storage: persistLocalStorage(),
      // Don't persist live status, error, or hydration flag; the listener +
      // Rust own those. Persist only the user-edited config so the UI doesn't
      // flash defaults on page reload.
      partialize: (state) => ({ config: state.config }),
    }
  )
)

// ========== Selectors ==========

export const selectInboundConfig = (s: RemoteControlStore) => s.config.inbound
export const selectOutboundConfig = (s: RemoteControlStore) => s.config.outbound
export const selectStatus = (s: RemoteControlStore) => s.status
export const selectRecentCalls = (s: RemoteControlStore) => s.recentCalls
