"use client"

/**
 * Remote-host store (ADR-0082, R0) — the desktop's registry of remote Cognia
 * hosts and the single place that switches which host the app is driving.
 *
 * Owns:
 *   - `hosts`: the persisted list of paired remote hosts (label + full
 *     `CompanionConfig`). Persisted to localStorage; the credential lives with
 *     only in the secure credential vault. Public v2 room metadata remains in
 *     the persisted config.
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

import { isCapabilityId, type CapabilityId } from "@/lib/platform/capabilities"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import {
  parseHostFeatureManifest,
  supportsHostFeatureOperation,
  type HostFeatureId,
  type HostFeatureManifest,
} from "@/lib/platform/host-feature-manifest"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { transport } from "@/lib/tauri/transport-instance"
import { setActiveRemoteEndpoint, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  clearRemoteHostCredential,
  loadRemoteHostCredential,
  remoteHostCredentialRef,
  saveRemoteHostCredential,
} from "@/lib/remote-host/credential-vault"

export interface RemoteHost {
  /** Stable local id (not the remote device id). */
  id: string
  /** User-facing name. Defaults to the host origin when not given. */
  label: string
  /** Runtime config. Secret fields are memory-only and stripped before persistence. */
  config: CompanionConfig
  /** Stable pointer to the OS keyring / encrypted secure-storage record. */
  credentialRef: string
  /** Epoch ms this host was added. */
  addedAt: number
  /** Epoch ms this host was last activated, if ever. */
  lastActiveAt?: number
  connectionState:
    "disconnected" | "connecting" | "ready" | "degraded" | "revoked" | "versionMismatch"
  /** Updated only after authentication and both capability probes succeed. */
  lastConnectedAt?: number
  connectionError?: string
  /**
   * What the host reported it can do, from its last activation.
   *
   * Without this a client judged a remote host by its OWN baseline: workflow
   * preflight would reject `always-on` / `headless` work that a cloud server
   * could run, because `remoteCapabilityUnion` only aggregates devices paired
   * *into* this machine and can never see the host being driven.
   */
  capabilities?: CapabilityId[]
  /** Epoch ms the capabilities above were fetched. */
  capabilitiesAt?: number
  /** Versioned operation-level contract reported by this host. */
  featureManifest?: HostFeatureManifest
  /** Epoch ms the feature manifest above was fetched. */
  featureManifestAt?: number
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

function withoutPersistedSecrets(config: CompanionConfig): CompanionConfig {
  return {
    ...config,
    deviceJwt: "",
    signalingPrivateKeyJwk: undefined,
    signalingPrivateKey: undefined,
  }
}

async function hydrateHostCredential(id: string): Promise<CompanionConfig | null> {
  const host = useRemoteHostStore.getState().hosts.find((candidate) => candidate.id === id)
  if (!host) return null
  if (host.config.deviceJwt) return host.config
  const credential = await loadRemoteHostCredential(id)
  if (!credential) return null
  const config: CompanionConfig = {
    ...host.config,
    deviceJwt: credential.deviceJwt,
    signalingPrivateKeyJwk: credential.signalingPrivateKeyJwk,
  }
  useRemoteHostStore.setState((state) => ({
    hosts: state.hosts.map((candidate) =>
      candidate.id === id ? { ...candidate, config } : candidate
    ),
  }))
  return config
}

function markConnectionFailure(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  const connectionState: RemoteHost["connectionState"] =
    normalized.includes("revoked") || normalized.includes("unauthorized")
      ? "revoked"
      : normalized.includes("version") || normalized.includes("upgrade")
        ? "versionMismatch"
        : "degraded"
  useRemoteHostStore.setState((state) => ({
    hosts: state.hosts.map((host) =>
      host.id === id ? { ...host, connectionState, connectionError: message } : host
    ),
  }))
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
  capabilities?: unknown
}

/** Hard cap on the stored list, matching the one the inbound device report
 *  applies in `lib/companion/desktop-write-source.ts` — well above the core
 *  vocabulary plus any sane number of `plugin:<id>` tags, and it bounds a
 *  hostile payload either direction. */
const MAX_REPORTED_CAPABILITIES = 64

/**
 * Fetch and store the active host's capability list.
 *
 * Routed through the shared `transport`, which at this point is already pointed
 * at the host, so this is the host answering about itself rather than the
 * desktop guessing.
 *
 * Returns `null` for every answer we cannot use — a throw, or a reply whose
 * `capabilities` is not an array. Both mean "the host did not tell us", and
 * both must leave the stored list alone: writing `[]` would look exactly like
 * a host that truthfully reported no capabilities, which is the local-baseline
 * misjudgement this probe exists to end. `null` also keeps the connection in
 * `degraded` rather than `ready` (see `connectRemoteHost`), so the UI says it
 * has not got an answer instead of showing an empty list as fact.
 */
export async function refreshHostCapabilities(id: string): Promise<CapabilityId[] | null> {
  try {
    const reply = await transport.call<HostCapabilitiesReply>("host_capabilities", {})
    if (!Array.isArray(reply?.capabilities)) {
      markConnectionFailure(id, "host_capabilities reply had no capability array")
      return null
    }
    // Validated and capped rather than stored raw: this list gates workflow
    // preflight, so an unrecognised tag must not read as a granted capability.
    const capabilities = reply.capabilities
      .filter(isCapabilityId)
      .slice(0, MAX_REPORTED_CAPABILITIES)
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((h) =>
        h.id === id ? { ...h, capabilities, capabilitiesAt: Date.now() } : h
      ),
    }))
    return capabilities
  } catch (error) {
    // An older host, or one that is momentarily unreachable. Keeping the last
    // known list is better than blanking it: a stale answer still beats
    // silently judging the host by the local baseline, which is the bug.
    markConnectionFailure(id, error)
    return null
  }
}

/** Capabilities of the host currently being driven, or `[]` when local. */
export function activeHostCapabilities(): CapabilityId[] {
  const state = useRemoteHostStore.getState()
  if (!state.activeHostId) return []
  return state.hosts.find((h) => h.id === state.activeHostId)?.capabilities ?? []
}

export async function refreshHostFeatureManifest(id: string): Promise<HostFeatureManifest | null> {
  try {
    const raw = await transport.call<unknown>("host_feature_manifest", {})
    const manifest = parseHostFeatureManifest(raw)
    const host = useRemoteHostStore.getState().hosts.find((candidate) => candidate.id === id)
    if (!manifest || !host) {
      useRemoteHostStore.setState((state) => ({
        hosts: state.hosts.map((candidate) =>
          candidate.id === id
            ? { ...candidate, featureManifest: undefined, featureManifestAt: undefined }
            : candidate
        ),
      }))
      return null
    }
    if (manifest.hostBuildId !== host.config.serverVersion) {
      useRemoteHostStore.setState((state) => ({
        hosts: state.hosts.map((candidate) =>
          candidate.id === id
            ? { ...candidate, featureManifest: undefined, featureManifestAt: undefined }
            : candidate
        ),
      }))
      markConnectionFailure(id, "host feature manifest version mismatch")
      return null
    }

    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((candidate) =>
        candidate.id === id
          ? { ...candidate, featureManifest: manifest, featureManifestAt: Date.now() }
          : candidate
      ),
    }))
    return manifest
  } catch (error) {
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((candidate) =>
        candidate.id === id
          ? { ...candidate, featureManifest: undefined, featureManifestAt: undefined }
          : candidate
      ),
    }))
    markConnectionFailure(id, error)
    return null
  }
}

async function probeHostConnection(id: string): Promise<void> {
  const [capabilities, manifest] = await Promise.all([
    refreshHostCapabilities(id),
    refreshHostFeatureManifest(id),
  ])
  const state = useRemoteHostStore.getState()
  if (state.activeHostId !== id) return
  const host = state.hosts.find((candidate) => candidate.id === id)
  if (!host || host.connectionState !== "connecting") return
  const ready = capabilities !== null && manifest !== null
  useRemoteHostStore.setState((current) => ({
    hosts: current.hosts.map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            connectionState: ready ? "ready" : "degraded",
            connectionError: ready ? undefined : candidate.connectionError,
            ...(ready ? { lastConnectedAt: Date.now() } : {}),
          }
        : candidate
    ),
  }))
}

export function activeHostFeatureManifest(): HostFeatureManifest | null {
  const state = useRemoteHostStore.getState()
  if (!state.activeHostId) return null
  const host = state.hosts.find((candidate) => candidate.id === state.activeHostId)
  if (
    !host?.featureManifest ||
    host.connectionState !== "ready" ||
    host.featureManifest.hostBuildId !== host.config.serverVersion
  ) {
    return null
  }
  return host.featureManifest
}

export function activeHostSupportsFeature(feature: HostFeatureId, operation?: string): boolean {
  return supportsHostFeatureOperation(activeHostFeatureManifest(), feature, operation)
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
          const updated: RemoteHost = {
            ...existing,
            config: cleanConfig,
            credentialRef: remoteHostCredentialRef(existing.id),
            connectionState: "disconnected",
            connectionError: undefined,
          }
          set({ hosts: get().hosts.map((h) => (h.id === existing.id ? updated : h)) })
          void saveRemoteHostCredential(existing.id, cleanConfig).catch(() => undefined)
          // If the refreshed host is active, re-install so the new JWT takes.
          if (get().activeHostId === existing.id) get().activateHost(existing.id)
          return updated
        }
        const id = `host-${nanoid(10)}`
        const host: RemoteHost = {
          id,
          label: (label ?? "").trim() || normalized,
          config: cleanConfig,
          credentialRef: remoteHostCredentialRef(id),
          addedAt: Date.now(),
          connectionState: "disconnected",
        }
        set({ hosts: [...get().hosts, host] })
        void saveRemoteHostCredential(id, cleanConfig).catch(() => undefined)
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
        void clearRemoteHostCredential(id).catch(() => undefined)
      },

      activateHost: (id) => {
        const host = get().hosts.find((h) => h.id === id)
        if (!host) return
        if (!host.config.deviceJwt) {
          void hydrateHostCredential(id).then((config) => {
            if (config) {
              get().activateHost(id)
            } else {
              markConnectionFailure(id, "remote host credential is unavailable")
            }
          })
          return
        }
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
          hosts: get().hosts.map((candidate) =>
            candidate.id === id
              ? {
                  ...candidate,
                  connectionState: "connecting",
                  connectionError: undefined,
                  featureManifest: undefined,
                  featureManifestAt: undefined,
                  lastActiveAt: Date.now(),
                }
              : candidate.connectionState === "disconnected"
                ? candidate
                : {
                    ...candidate,
                    connectionState: "disconnected",
                    connectionError: undefined,
                  }
          ),
        })
        // Ask the host what it can do. Fire-and-forget: activation must not
        // block on it, and a host too old to know the command simply keeps
        // whatever it reported last (or none).
        void probeHostConnection(id)
      },

      deactivate: () => {
        const activeHostId = get().activeHostId
        setActiveRemoteTransport(null)
        setActiveRemoteEndpoint(null)
        void transport.call("codeserver_remote_relay_stop", {}).catch(() => undefined)
        set({
          activeHostId: null,
          hosts: get().hosts.map((host) =>
            host.id === activeHostId
              ? {
                  ...host,
                  connectionState: "disconnected",
                  connectionError: undefined,
                }
              : host
          ),
        })
      },
    }),
    {
      name: "cognia-remote-hosts",
      storage: persistLocalStorage(),
      version: 2,
      migrate: async (persisted, version) => {
        const state = persisted as Partial<RemoteHostState>
        const hosts = Array.isArray(state.hosts) ? state.hosts : []
        if (version < 2) {
          await Promise.all(
            hosts.map(async (host) => {
              if (host.config?.deviceJwt) {
                await saveRemoteHostCredential(host.id, host.config).catch(() => undefined)
              }
            })
          )
        }
        return {
          ...state,
          activeHostId: null,
          hosts: hosts.map((host) => ({
            ...host,
            connectionState: "disconnected",
            connectionError: undefined,
            credentialRef: remoteHostCredentialRef(host.id),
            config: withoutPersistedSecrets(host.config),
          })),
        } as RemoteHostState
      },
      // Persist the host list only — the active host is session-scoped so every
      // launch starts local (ADR-0082).
      partialize: (state) => ({
        hosts: state.hosts.map((host) => ({
          ...host,
          config: withoutPersistedSecrets(host.config),
        })),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        for (const host of state.hosts) {
          void hydrateHostCredential(host.id)
        }
      },
    }
  )
)

export default useRemoteHostStore
