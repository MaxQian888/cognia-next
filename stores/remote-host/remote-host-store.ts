"use client"

/**
 * Remote-host store (ADR-0082, R0) — the desktop's registry of remote Cognia
 * hosts and the single place that switches which host the app is driving.
 *
 * Owns:
 *   - `hosts`: the persisted list of paired remote hosts (label + full
 *     `CompanionConfig`). Persisted to localStorage; the credential lives with
 *     only in the secure credential vault. Public room metadata remains in
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
import { isMainAppWindow } from "@/lib/pet/window-role"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { notifyRemoteHostPairingChanged } from "@/lib/platform/remote-host-pairing"
import { persistLocalStorage } from "@/stores/persist-storage"

import { isCapabilityId, type CapabilityId } from "@/lib/platform/capabilities"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import {
  parseHostFeatureManifest,
  supportsHostFeatureOperation,
  type HostFeatureId,
  type HostFeatureManifest,
} from "@/lib/platform/host-feature-manifest"
import { codeServerClient } from "@/lib/codeserver/client"
import { COMPANION_CONTRACT_VERSION } from "@/lib/tauri/command-descriptors"
import { onHostBrainChange, onHostContractChange } from "@/lib/tauri/companion-contract"
import { nextHostVersionState, type HostVersionState } from "@/lib/remote-host/host-version"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { transport } from "@/lib/tauri/transport-instance"
import { setActiveRemoteEndpoint, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { importSigningPrivateKey } from "@/lib/signaling/crypto"
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
  /**
   * An always-on host the user brings (ADR-0224): their own VPS, NAS or Mac
   * mini running bots, schedules and connectors around the clock. It is a
   * peer of this desktop, so pairing one records it here without switching
   * this window to it.
   */
  alwaysOn?: boolean
  /**
   * How this desktop installed the Host, when it did (ADR-0235): the saved SSH
   * profile that reaches its machine. The device console's "This machine"
   * controls reopen the installer through it to repair, re-pair or uninstall.
   * Like `alwaysOn` it never alters the config, activation or routing, and as
   * an optional field it survives `partialize` and `merge` with no persist
   * version bump.
   */
  installBinding?: HostInstallBinding
  /**
   * The last liveness probe through the management channel (ADR-0224 A4).
   *
   * A host this desktop is not routing to has no live connection to report on,
   * so without a probe its `lastConnectedAt` froze at the last activation and
   * every reader (the device console, the ADR-0136 timing authority) saw an
   * always-on host as gone. Session evidence, like `connectionState`: it is
   * not trusted across a relaunch.
   */
  lastProbe?: RemoteHostProbe
  /**
   * Which side to update, from the last handshake (ADR-0175, ADR-0224 A10).
   * Persisted: the in-memory contract verdict starts `unknown` on every
   * launch, and the console should still say "update the host" before the
   * next handshake. See `lib/remote-host/host-version.ts`.
   */
  version?: HostVersionState
}

/** The machine a Host was installed on, as this desktop reaches it. */
export interface HostInstallBinding {
  kind: "ssh"
  /** The saved SSH profile (`settings.terminal.sshHosts[].id`). */
  profileId: string
  /** Epoch ms the install finished. */
  installedAt: number
}

export interface RemoteHostProbe {
  /** Epoch ms the probe settled. */
  at: number
  /** Whether the host answered with a usable, version-matched manifest. */
  ok: boolean
  /** Why it did not, verbatim, when `ok` is false. */
  error?: string
}

export interface RemoteHostState {
  hosts: RemoteHost[]
  /** Session-scoped: which host the desktop is driving; `null` = local. */
  activeHostId: string | null

  /**
   * Register (or, on a repeat baseUrl, update) a paired host. Returns it.
   * `alwaysOn` marks an always-on peer; a re-pair that omits it keeps the
   * host's existing role.
   */
  addHost: (input: {
    label?: string
    config: CompanionConfig
    alwaysOn?: boolean
    installBinding?: HostInstallBinding
  }) => RemoteHost
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
    devicePrivateKeyJwk: undefined,
    serviceToken: undefined,
    signalingPrivateKeyJwk: undefined,
    signalingPrivateKey: undefined,
  }
}

/**
 * Whether a config can take the relay route: its signaling key is a usable
 * `CryptoKey`, not only the JWK the credential vault and pairing hand back.
 * `CompanionTransport` signs the room with the `CryptoKey`; without it the
 * relay fallback is silently off, which strands a host behind NAT.
 */
export function needsSigningKeyImport(config: CompanionConfig): boolean {
  return config.signalingPrivateKeyJwk !== undefined && config.signalingPrivateKey === undefined
}

/** Import the signaling key so the relay route is available. */
export async function withSigningKey(config: CompanionConfig): Promise<CompanionConfig> {
  if (!needsSigningKeyImport(config)) return config
  return {
    ...config,
    signalingPrivateKey: await importSigningPrivateKey(config.signalingPrivateKeyJwk!),
  }
}

async function hydrateHostCredential(id: string): Promise<CompanionConfig | null> {
  const host = useRemoteHostStore.getState().hosts.find((candidate) => candidate.id === id)
  if (!host) return null
  let config: CompanionConfig
  if (host.config.devicePrivateKeyJwk) {
    if (!needsSigningKeyImport(host.config)) return host.config
    config = host.config
  } else {
    const credential = await loadRemoteHostCredential(id)
    if (!credential) return null
    config = {
      ...host.config,
      devicePrivateKeyJwk: credential.devicePrivateKeyJwk,
      signalingPrivateKeyJwk: credential.signalingPrivateKeyJwk,
    }
  }
  try {
    config = await withSigningKey(config)
  } catch {
    // A key that will not import leaves the direct route working; only the
    // relay fallback is lost, and the transport says so when it needs it.
    // Dropped from this in-memory copy (the vault keeps it) so activation
    // does not come back here forever.
    config = { ...config, signalingPrivateKeyJwk: undefined }
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

/**
 * The factory the store activates hosts through, exposed so the isolated
 * per-host path (`lib/remote-host/target-transport.ts`) builds its transport
 * the same way.
 *
 * They were two constructions of the same thing, which meant a test seam
 * installed here did not cover a probe opened there, and any future change to
 * how a companion transport is built had two places to remember.
 */
export function getRemoteTransportFactory(): RemoteTransportFactory {
  return transportFactory
}

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
    // A host that reports another build than the one it was paired at has
    // been updated. Versions are judged by the command contract (ADR-0175),
    // through the handshake verdict, not by the build: so the build it runs
    // now is adopted rather than refused (ADR-0224 A10).
    if (manifest.hostBuildId !== host.config.serverVersion) adoptHostBuild(id, manifest.hostBuildId)

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

/** What a liveness probe through the management channel came back with. */
export type HostProbeOutcome =
  { kind: "answered"; manifest: unknown } | { kind: "failed"; error: unknown }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRevocation(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("revoked") || normalized.includes("unauthorized")
}

/**
 * Record a liveness probe of a host (ADR-0224 A4).
 *
 * A usable answer is the same one activation accepts: a parseable feature
 * manifest from the build this pairing was made with. It refreshes the
 * manifest and `lastConnectedAt`, which is the timestamp the device console
 * and the ADR-0136 timing authority read, so an always-on host the desktop is
 * not driving no longer looks gone five minutes after the last activation.
 *
 * The routed connection's state belongs to activation: for the active host a
 * probe only adds evidence. For an inactive host it records the two facts a
 * probe can establish on its own (revoked, wrong version) and clears them once
 * the host answers properly again. A host that merely did not answer keeps its
 * state; `lastProbe` says it did not answer.
 */
export function recordHostProbe(
  id: string,
  outcome: HostProbeOutcome,
  now: number = Date.now()
): RemoteHostProbe | null {
  const state = useRemoteHostStore.getState()
  const host = state.hosts.find((candidate) => candidate.id === id)
  if (!host) return null
  const active = state.activeHostId === id

  let probe: RemoteHostProbe
  let patch: Partial<RemoteHost> = {}
  if (outcome.kind === "failed") {
    const message = errorText(outcome.error)
    probe = { at: now, ok: false, error: message }
    if (!active && isRevocation(message)) {
      patch = { connectionState: "revoked", connectionError: message }
    }
  } else {
    const manifest = parseHostFeatureManifest(outcome.manifest)
    if (!manifest) {
      probe = { at: now, ok: false, error: "the host's feature manifest could not be read" }
    } else {
      probe = { at: now, ok: true }
      patch = { featureManifest: manifest, featureManifestAt: now, lastConnectedAt: now }
      // An updated host reports its new build: adopt it (see
      // `refreshHostFeatureManifest`). Whether this app still matches it is
      // the handshake verdict's call, kept in `version`.
      if (manifest.hostBuildId !== host.config.serverVersion) {
        patch = { ...patch, config: { ...host.config, serverVersion: manifest.hostBuildId } }
      }
      const mismatched = (host.version?.advice ?? "none") !== "none"
      if (!active && !mismatched && host.connectionState !== "disconnected") {
        patch = { ...patch, connectionState: "disconnected", connectionError: undefined }
      }
    }
  }

  useRemoteHostStore.setState((current) => ({
    hosts: current.hosts.map((candidate) =>
      candidate.id === id ? { ...candidate, ...patch, lastProbe: probe } : candidate
    ),
  }))
  return probe
}

/**
 * Hosts as they come back from storage. Connection state is session evidence:
 * a `ready` written while the last session was driving the host said nothing
 * about this one, yet the device console read it as a live socket. Only a
 * revocation is a durable fact about the pairing; everything else starts
 * disconnected until activation or a probe says otherwise.
 */
export function rehydratedHosts(hosts: readonly RemoteHost[]): RemoteHost[] {
  return hosts.map((host) => {
    const { lastProbe: _session, ...rest } = host
    if (host.connectionState === "revoked") return rest
    // Which side to update is a durable fact about the two builds, so it
    // survives a relaunch until the next handshake says otherwise.
    const mismatched = (host.version?.advice ?? "none") !== "none"
    return {
      ...rest,
      connectionState: mismatched ? "versionMismatch" : "disconnected",
      connectionError: undefined,
    }
  })
}

/** Record the build a host now runs, as reported by its feature manifest. */
function adoptHostBuild(id: string, hostBuildId: string): void {
  useRemoteHostStore.setState((state) => ({
    hosts: state.hosts.map((candidate) =>
      candidate.id === id
        ? { ...candidate, config: { ...candidate.config, serverVersion: hostBuildId } }
        : candidate
    ),
  }))
}

/**
 * Keep each host's {@link RemoteHost.version} in step with its handshakes.
 *
 * Every transport to a host, the active one and the management channels
 * alike, records the contract verdict and the brain report under the
 * pairing's device id; this folds them onto the host record that pairing
 * belongs to. A mismatch shows as `versionMismatch`; a host that matches
 * again leaves it. Returns a disposer. Installed once below.
 */
export function installHostVersionTracking(): () => void {
  const apply = (deviceId: string, fact: Parameters<typeof nextHostVersionState>[1]): void => {
    useRemoteHostStore.setState((state) => {
      let changed = false
      const hosts = state.hosts.map((host) => {
        if (host.config.deviceId !== deviceId) return host
        const version = nextHostVersionState(
          host.version,
          fact,
          COMPANION_CONTRACT_VERSION,
          Date.now()
        )
        if (version === host.version) return host
        changed = true
        const mismatched = (version?.advice ?? "none") !== "none"
        const connectionState: RemoteHost["connectionState"] =
          host.connectionState === "revoked"
            ? "revoked"
            : mismatched
              ? "versionMismatch"
              : host.connectionState === "versionMismatch" && state.activeHostId !== host.id
                ? "disconnected"
                : host.connectionState
        return { ...host, ...(version ? { version } : {}), connectionState }
      })
      return changed ? { hosts } : state
    })
  }
  const offContract = onHostContractChange((deviceId, verdict) =>
    apply(deviceId, { kind: "contract", verdict })
  )
  const offBrain = onHostBrainChange((deviceId, refusal) =>
    apply(deviceId, { kind: "brain", refusal })
  )
  return () => {
    offContract()
    offBrain()
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

/**
 * The active host's usable feature manifest within a given store state.
 *
 * Pure over its input so the imperative reader below and the React selector in
 * {@link useActiveHostSupportsFeature} answer from one rule: a manifest only
 * counts while the host is `ready` and still reports the build it was fetched
 * from.
 */
function activeManifestIn(
  state: Pick<RemoteHostState, "hosts" | "activeHostId">
): HostFeatureManifest | null {
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

export function activeHostFeatureManifest(): HostFeatureManifest | null {
  return activeManifestIn(useRemoteHostStore.getState())
}

/**
 * Imperative read, for non-React callers (transports, lib routes). A component
 * must use {@link useActiveHostSupportsFeature} instead: this reads the store
 * once, so a render that calls it keeps the answer for the host that was active
 * when it last rendered and goes stale after a host switch.
 */
export function activeHostSupportsFeature(feature: HostFeatureId, operation?: string): boolean {
  return supportsHostFeatureOperation(activeHostFeatureManifest(), feature, operation)
}

/**
 * {@link activeHostSupportsFeature} as a subscription. Re-renders the caller
 * when the active host changes, when its probe settles (`connecting` →
 * `ready`), and when its manifest is replaced, which are exactly the moments
 * the answer can flip. Selects a boolean, so unrelated store writes (a rename,
 * another host's state) do not re-render.
 */
export function useActiveHostSupportsFeature(feature: HostFeatureId, operation?: string): boolean {
  return useRemoteHostStore((state) =>
    supportsHostFeatureOperation(activeManifestIn(state), feature, operation)
  )
}

const hostPersistence = persistLocalStorage()

export const useRemoteHostStore = create<RemoteHostState>()(
  persist(
    (set, get) => ({
      hosts: [],
      activeHostId: null,

      addHost: ({ label, config, alwaysOn, installBinding }) => {
        if (!config.devicePrivateKeyJwk || !config.deviceKeyThumbprint) {
          throw new Error("remote host device identity is unavailable; pair again")
        }
        const normalized = normalizeBaseUrl(config.baseUrl)
        const cleanConfig: CompanionConfig = { ...config, baseUrl: normalized }
        const credential = {
          devicePrivateKeyJwk: config.devicePrivateKeyJwk,
          signalingPrivateKeyJwk: config.signalingPrivateKeyJwk,
        }
        const existing = get().hosts.find((h) => normalizeBaseUrl(h.config.baseUrl) === normalized)
        if (existing) {
          // Re-pairing the same origin refreshes credentials; keep id + label.
          const updated: RemoteHost = {
            ...existing,
            config: cleanConfig,
            credentialRef: remoteHostCredentialRef(existing.id),
            connectionState: "disconnected",
            connectionError: undefined,
            ...(alwaysOn === undefined ? {} : { alwaysOn }),
            ...(installBinding ? { installBinding } : {}),
          }
          set({ hosts: get().hosts.map((h) => (h.id === existing.id ? updated : h)) })
          notifyRemoteHostPairingChanged()
          void saveRemoteHostCredential(existing.id, credential).catch(() => undefined)
          // If the refreshed host is active, re-install so the new key takes.
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
          ...(alwaysOn ? { alwaysOn: true } : {}),
          ...(installBinding ? { installBinding } : {}),
        }
        set({ hosts: [...get().hosts, host] })
        // The host profile is derived from this list, and localStorage has no
        // same-tab change event, so the surfaces already mounted are told here.
        notifyRemoteHostPairingChanged()
        void saveRemoteHostCredential(id, credential).catch(() => undefined)
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
        notifyRemoteHostPairingChanged()
        void clearRemoteHostCredential(id).catch(() => undefined)
      },

      activateHost: (id) => {
        const host = get().hosts.find((h) => h.id === id)
        if (!host) return
        if (
          !host.config.devicePrivateKeyJwk ||
          !host.config.deviceKeyThumbprint ||
          needsSigningKeyImport(host.config)
        ) {
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
          remoteHost: { id: host.id, label: host.label },
          baseUrl: host.config.baseUrl,
          deviceId: host.config.deviceId,
          devicePrivateKeyJwk: host.config.devicePrivateKeyJwk,
          deviceKeyThumbprint: host.config.deviceKeyThumbprint,
          accountId: host.config.accountId,
          serverVersion: host.config.serverVersion,
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
        // Must precede the detach below. `codeserver_stop_all` is not a
        // local-only command, so issued here it reaches the host that is still
        // active; detaching first would send it to the desktop and leave the
        // remote host's IDE children running for the life of that process —
        // `list_managed_processes` IS local-only, so they never show up in
        // Managed Processes, and `RemoteCodeServerState` has no idle reaper.
        // This also drops the desktop relay, which is why no separate
        // `codeserver_remote_relay_stop` call is needed here.
        void codeServerClient.stopAll().catch(() => undefined)
        setActiveRemoteTransport(null)
        setActiveRemoteEndpoint(null)
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
      // Overlays read metadata but must not consume a legacy migration before
      // main can remove its old credentials. Zustand writes migration results
      // automatically, so enforce read-only persistence at this boundary too.
      storage: hostPersistence && {
        getItem: hostPersistence.getItem,
        setItem: (name, value) => {
          if (isMainAppWindow()) return hostPersistence.setItem(name, value)
        },
        removeItem: (name) => {
          if (isMainAppWindow()) return hostPersistence.removeItem(name)
        },
      },
      version: 3,
      migrate: async (persisted, version) => {
        const state = persisted as Partial<RemoteHostState>
        const priorHosts = Array.isArray(state.hosts) ? state.hosts : []
        const hosts = version < 3 ? [] : priorHosts
        if (version < 3 && isMainAppWindow()) {
          await Promise.all(
            priorHosts.map((host) => clearRemoteHostCredential(host.id).catch(() => undefined))
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
      merge: (persisted, current) => {
        const stored = persisted as Partial<RemoteHostState> | undefined
        return {
          ...current,
          ...stored,
          activeHostId: null,
          hosts: rehydratedHosts(Array.isArray(stored?.hosts) ? stored.hosts : current.hosts),
        }
      },
      onRehydrateStorage: () => (state) => {
        // The module is imported by lightweight overlays too. They may read
        // public host metadata, but only the main window owns credentials.
        if (!state || !isMainAppWindow()) return
        // Deferred: with synchronous storage this runs while `create()` is
        // still building the store, so `useRemoteHostStore` is not assigned
        // yet and reading it throws (seen once a host was persisted).
        const ids = state.hosts.map((host) => host.id)
        queueMicrotask(() => {
          for (const id of ids) void hydrateHostCredential(id).catch(() => null)
        })
      },
    }
  )
)

installHostVersionTracking()

export default useRemoteHostStore
