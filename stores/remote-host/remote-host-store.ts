"use client"

/**
 * Remote-host store (ADR-0082, R0) — the desktop's registry of remote Cognia
 * hosts and the single place that switches which host the app is driving.
 *
 * Owns:
 *   - `hosts`: the persisted list of paired remote hosts (label + full
 *     `CompanionConfig`). Persisted to localStorage; the credential lives with
 *     the config (v1 reuses the same at-rest model the mobile companion uses —
 *     a hardened secret-store home is future work, see ADR-0082).
 *   - `activeHostId`: which host is currently driving the desktop. This is
 *     SESSION-scoped and deliberately NOT persisted — every launch starts local
 *     so the app never silently drives a remote machine on boot.
 *
 * Activating a host installs a per-host `CompanionTransport` as the active
 * remote (so every `transport.call`/`subscribe` routes to it) plus the raw
 * WebSocket endpoint descriptor (so the interactive terminal targets it). Both
 * are cleared on deactivate — the zero-regression local baseline.
 */

import { nanoid } from "nanoid"
import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { setActiveRemoteEndpoint, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"

export interface RemoteHost {
  /** Stable local id (not the remote device id). */
  id: string
  /** User-facing name. Defaults to the host origin when not given. */
  label: string
  /** Full companion credential for this host — the routing/terminal source. */
  config: CompanionConfig
  /** Epoch ms this host was added. */
  addedAt: number
  /** Epoch ms this host was last activated, if ever. */
  lastActiveAt?: number
}

export interface RemoteHostState {
  hosts: RemoteHost[]
  /** Session-scoped: which host the desktop is driving; `null` = local. */
  activeHostId: string | null

  /** Register (or, on a repeat baseUrl, update) a paired host. Returns it. */
  addHost: (input: { label?: string; config: CompanionConfig }) => RemoteHost
  /** Rename a host. No-op if the id is unknown. */
  updateHostLabel: (id: string, label: string) => void
  /** Remove a host; deactivates first if it is the active one. */
  removeHost: (id: string) => void
  /** Start driving a host: install its transport + terminal endpoint. */
  activateHost: (id: string) => void
  /** Stop driving any remote host; route locally again. */
  deactivate: () => void
}

/** Strip a trailing slash so `https://h:1/` and `https://h:1` dedupe. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

// Injectable transport factory — production builds a real `CompanionTransport`;
// tests swap a fake to stay clear of the network stack and to assert the
// (never-null) config provider handed to it.
type RemoteTransportFactory = (configProvider: () => CompanionConfig) => Transport

const defaultTransportFactory: RemoteTransportFactory = (configProvider) =>
  new CompanionTransport({ configProvider })

let transportFactory: RemoteTransportFactory = defaultTransportFactory

/** Test-only override of the remote transport factory. */
export function __setRemoteTransportFactoryForTests(factory: RemoteTransportFactory | null): void {
  transportFactory = factory ?? defaultTransportFactory
}

export const useRemoteHostStore = create<RemoteHostState>()(
  persist(
    (set, get) => ({
      hosts: [],
      activeHostId: null,

      addHost: ({ label, config }) => {
        const normalized = normalizeBaseUrl(config.baseUrl)
        const cleanConfig: CompanionConfig = { ...config, baseUrl: normalized }
        const existing = get().hosts.find((h) => normalizeBaseUrl(h.config.baseUrl) === normalized)
        if (existing) {
          // Re-pairing the same origin refreshes credentials; keep id + label.
          const updated: RemoteHost = { ...existing, config: cleanConfig }
          set({ hosts: get().hosts.map((h) => (h.id === existing.id ? updated : h)) })
          // If the refreshed host is active, re-install so the new JWT takes.
          if (get().activeHostId === existing.id) get().activateHost(existing.id)
          return updated
        }
        const host: RemoteHost = {
          id: `host-${nanoid(10)}`,
          label: (label ?? "").trim() || normalized,
          config: cleanConfig,
          addedAt: Date.now(),
        }
        set({ hosts: [...get().hosts, host] })
        return host
      },

      updateHostLabel: (id, label) => {
        const trimmed = label.trim()
        set({
          hosts: get().hosts.map((h) =>
            h.id === id ? { ...h, label: trimmed || h.config.baseUrl } : h
          ),
        })
      },

      removeHost: (id) => {
        if (get().activeHostId === id) get().deactivate()
        set({ hosts: get().hosts.filter((h) => h.id !== id) })
      },

      activateHost: (id) => {
        const host = get().hosts.find((h) => h.id === id)
        if (!host) return
        // The config provider must NEVER return null (CompanionTransport rejects
        // with `not_paired` otherwise). Read the freshest config from the store,
        // falling back to the value captured at activation if the row vanishes.
        const captured = host.config
        const configProvider = (): CompanionConfig =>
          get().hosts.find((h) => h.id === id)?.config ?? captured
        setActiveRemoteTransport(transportFactory(configProvider))
        setActiveRemoteEndpoint({ baseUrl: host.config.baseUrl, deviceJwt: host.config.deviceJwt })
        set({
          activeHostId: id,
          hosts: get().hosts.map((h) => (h.id === id ? { ...h, lastActiveAt: Date.now() } : h)),
        })
      },

      deactivate: () => {
        setActiveRemoteTransport(null)
        setActiveRemoteEndpoint(null)
        set({ activeHostId: null })
      },
    }),
    {
      name: "cognia-remote-hosts",
      version: 1,
      // Persist the host list only — the active host is session-scoped so every
      // launch starts local (ADR-0082).
      partialize: (state) => ({ hosts: state.hosts }),
    }
  )
)

export default useRemoteHostStore
