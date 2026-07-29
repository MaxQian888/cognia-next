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
import { persistLocalStorage } from "@/stores/persist-storage"

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { transport } from "@/lib/tauri/transport-instance"
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
  /**
   * What the host reported it can do, from its last activation.
   *
   * Without this a client judged a remote host by its OWN baseline: workflow
   * preflight would reject `always-on` / `headless` work that a cloud server
   * could run, because `remoteCapabilityUnion` only aggregates devices paired
   * *into* this machine and can never see the host being driven.
   */
  capabilities?: string[]
  /** Epoch ms the capabilities above were fetched. */
  capabilitiesAt?: number
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

interface HostCapabilitiesReply {
  platform?: string
  capabilities?: string[]
}

/**
 * Fetch and store the active host's capability list.
 *
 * Routed through the shared `transport`, which at this point is already pointed
 * at the host, so this is the host answering about itself rather than the
 * desktop guessing.
 */
export async function refreshHostCapabilities(id: string): Promise<string[] | null> {
  try {
    const reply = await transport.call<HostCapabilitiesReply>("host_capabilities", {})
    const capabilities = Array.isArray(reply?.capabilities) ? reply.capabilities : []
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((h) =>
        h.id === id ? { ...h, capabilities, capabilitiesAt: Date.now() } : h
      ),
    }))
    return capabilities
  } catch {
    // An older host, or one that is momentarily unreachable. Keeping the last
    // known list is better than blanking it: a stale answer still beats
    // silently judging the host by the local baseline, which is the bug.
    return null
  }
}

/** Capabilities of the host currently being driven, or `[]` when local. */
export function activeHostCapabilities(): string[] {
  const state = useRemoteHostStore.getState()
  if (!state.activeHostId) return []
  return state.hosts.find((h) => h.id === state.activeHostId)?.capabilities ?? []
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
        setActiveRemoteEndpoint({
          baseUrl: host.config.baseUrl,
          deviceJwt: host.config.deviceJwt,
          serverFingerprint: host.config.serverFingerprint,
        })
        set({
          activeHostId: id,
          hosts: get().hosts.map((h) => (h.id === id ? { ...h, lastActiveAt: Date.now() } : h)),
        })
        // Ask the host what it can do. Fire-and-forget: activation must not
        // block on it, and a host too old to know the command simply keeps
        // whatever it reported last (or none).
        void refreshHostCapabilities(id)
      },

      deactivate: () => {
        setActiveRemoteTransport(null)
        setActiveRemoteEndpoint(null)
        void transport.call("codeserver_remote_relay_stop", {}).catch(() => undefined)
        set({ activeHostId: null })
      },
    }),
    {
      name: "cognia-remote-hosts",
      storage: persistLocalStorage(),
      version: 1,
      // Persist the host list only — the active host is session-scoped so every
      // launch starts local (ADR-0082).
      partialize: (state) => ({ hosts: state.hosts }),
    }
  )
)

export default useRemoteHostStore
