/** Host-bound managed desktop RPCs. No provider credential or traffic URL crosses this seam. */
import { localTransport, onTransportChange } from "@/lib/tauri/transport-instance"
import {
  acquireManagementChannel,
  withManagementChannel,
} from "@/lib/remote-host/management-channel"
import {
  HostConsentRequiredError,
  issueHostAdminLease,
  type HostAdminLease,
} from "@/lib/tauri/admin-lease"
import type { Transport } from "@/lib/tauri/transport-types"
import { effectiveConnectionState } from "@/hooks/companion/use-connection-state"
import {
  loadCompanionConfig,
  getCompanionConfigGeneration,
  type ConnectionState,
  type TransportTier,
} from "@/lib/tauri/transport-companion"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { pairedHostIdOf } from "@/lib/remote-host/target-transport"
import type { EgressTier, IsolationTier } from "@/types/sandbox/environment-spec"
import type {
  SandboxControlLease,
  SandboxDesktopFrame,
  SandboxDesktopSession,
  SandboxDesktopStatus,
} from "./sandbox-client"
import { useAccountStore } from "@/stores/account/account-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { E2bSandboxConfig } from "@/types/sandbox"

export type ManagedDesktopTarget = E2bSandboxConfig["target"]
export interface ManagedDesktopConfigSummary {
  id: string
  ownerPrincipalId: string
  hostId: string
  enabled: boolean
  canPrepareTemplate: boolean
  canCreate: boolean
  /** False until the Host records an authorized, measured GUI smoke receipt. */
  guiQualified?: boolean
  isolationTier: IsolationTier
  egressTier: EgressTier
  egressEnforcement: "provider-enforced" | "unverified"
  templateState?: "registering" | "registered" | "building" | "ready" | "unknown" | "failed" | null
  qualification: "unqualified" | "qualified"
  reason?: string | null
  maxConcurrent: number
  maxLifetimeSeconds: number
  idleTimeoutSeconds: number
  region?: string | null
  cpuCount: number
  memoryMb: number
  template?: {
    templateId: string
    buildId: string
    imageDigest: string
    recipeRevision: string
    protocol: string
  } | null
}
export interface ManagedDesktopQuote {
  id: string
  providerConfigId: string
  lifetimeSeconds: number
  expiresAt: number
  currency: string
  hourlyRateMicros: number
  maximumComputeCostMicros: number
  priceObservedAt: number
  region?: string | null
  cpuCount: number
  memoryMb: number
  configRevision: number
}
export interface ManagedDesktopResource {
  id: string
  providerConfigId: string
  generation: number
  state: "creating" | "running" | "deleting" | "destroyRetrying" | "destroyed" | "error"
  deadlineAt: number
  idleTimeoutSeconds: number
  createdAt: number
  updatedAt: number
  lastErrorCode?: string | null
  cleanupAttempts: number
  qualification: "unqualified" | "qualified" | "smoke"
}
export interface ManagedDesktopHealth {
  reachable: boolean
  state: ManagedDesktopResource["state"]
  desktop: ManagedDesktopResource
  errorCode?: string | null
}
export interface ManagedDesktopRef {
  desktopId: string
  generation: number
}
export interface ManagedDesktopCreation {
  providerConfigId: string
  quoteId: string
  authorizationId: string
  idempotencyKey: string
}
export interface ManagedDesktopAuthorization {
  id: string
  expiresAt: number
}

// Leases are tied to the actual authenticated management transport, never merely
// its display id. Re-pairing replaces the transport and cannot reuse the lease.
const adminLeases = new WeakMap<
  Transport,
  {
    lease: HostAdminLease
    account: ReturnType<typeof useAccountStore.getState>
    hostConfig: string | undefined
  }
>()
const ADMIN_OPERATIONS = [
  "managed_desktop_authorize",
  "managed_desktop_prepare_template",
  "managed_desktop_create",
  "managed_desktop_connect",
  "managed_desktop_delete",
]

/** Public pairing projection shared by lifecycle and the settings identity boundary. */
export function managedDesktopTargetConfig(target: ManagedDesktopTarget): string | undefined {
  if (target.kind === "local") return "local"
  const account = useAccountStore.getState()
  if (account.locked || !account.unlockedAccountId) return undefined
  const paired = pairedHostIdOf(target.hostId)
  if (paired) {
    const active = getActiveRuntimeTargetContext()
    const config = loadCompanionConfig()
    if (
      active?.targetId !== paired ||
      config?.targetId !== paired ||
      config.accountId !== account.unlockedAccountId ||
      active.accountId !== account.unlockedAccountId
    )
      return undefined
    const publicConfig = { ...config }
    delete publicConfig.devicePrivateKeyJwk
    delete publicConfig.signalingPrivateKeyJwk
    delete publicConfig.signalingPrivateKey
    delete publicConfig.serviceToken
    return JSON.stringify(publicConfig)
  }
  const host = useRemoteHostStore
    .getState()
    .hosts.find(
      (candidate) =>
        candidate.id === target.hostId ||
        (candidate.featureManifest?.schemaVersion === 2 &&
          candidate.featureManifest.hostIdentity.id === target.hostId)
    )
  if (!host || host.config.accountId !== account.unlockedAccountId) return undefined
  return JSON.stringify(host.config)
}

export function subscribeManagedDesktopTargetChanges(listener: () => void): () => void {
  const detach = [
    useRemoteHostStore.subscribe(listener),
    subscribeRuntimeTargetContext(listener),
    onTransportChange(listener),
  ]
  if (typeof window !== "undefined")
    window.addEventListener("cognia:companion-config-changed", listener)
  return () => {
    detach.forEach((unsubscribe) => unsubscribe())
    if (typeof window !== "undefined")
      window.removeEventListener("cognia:companion-config-changed", listener)
  }
}

/** Capture before opening a channel; invalidation is sticky across account/pairing ABA. */
export function managedDesktopIdentityScope(
  target: ManagedDesktopTarget,
  onInvalidated = () => {}
) {
  const account = useAccountStore.getState()
  if (account.locked || !account.unlockedAccountId)
    throw new Error("managed_desktop_authentication_required")
  if (target.kind === "remote" && !target.hostId.trim())
    throw new Error("managed desktop host is required")
  const readHostConfig = () => managedDesktopTargetConfig(target)
  const pairedGeneration =
    target.kind === "remote" && pairedHostIdOf(target.hostId)
      ? getCompanionConfigGeneration()
      : undefined
  const hostConfig = readHostConfig()
  let invalidated = false
  const invalidate = () => {
    if (invalidated) return
    invalidated = true
    onInvalidated()
  }
  const check = () => {
    const current = useAccountStore.getState()
    if (
      current.locked ||
      current.unlockedAccountId !== account.unlockedAccountId ||
      readHostConfig() !== hostConfig ||
      (pairedGeneration !== undefined && pairedGeneration !== getCompanionConfigGeneration()) ||
      (target.kind === "remote" && hostConfig === undefined)
    )
      invalidate()
  }
  const detach = [
    useAccountStore.subscribe(check),
    subscribeManagedDesktopTargetChanges(check),
    onTransportChange(invalidate),
  ]
  return {
    account,
    hostConfig,
    assertActive: () => {
      check()
      if (invalidated) throw new Error("managed_desktop_session_invalidated")
    },
    assertChannel: (config: unknown) => {
      if (JSON.stringify(config) !== hostConfig) invalidate()
      check()
      if (invalidated) throw new Error("managed_desktop_session_invalidated")
    },
    dispose: () => detach.forEach((unsubscribe) => unsubscribe()),
  }
}

async function call<T>(
  target: ManagedDesktopTarget,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const identity = managedDesktopIdentityScope(target)
  try {
    identity.assertActive()
    if (target.kind === "local") {
      const result = await localTransport.call<T>("managed_desktop_local_call", { name, args })
      identity.assertActive()
      return result
    }
    return await withManagementChannel(target.hostId, async (channel) => {
      identity.assertChannel(channel.host.config)
      if (!ADMIN_OPERATIONS.includes(name)) {
        const result = await channel.transport.call<T>(name, args)
        identity.assertActive()
        return result
      }
      const cached = adminLeases.get(channel.transport)
      // An account-store transition also prevents reuse of a completed call's lease.
      let admin =
        cached?.account === identity.account && cached.hostConfig === identity.hostConfig
          ? cached.lease
          : undefined
      if (!admin || admin.expiresAt <= Date.now() || !admin.operations.includes(name)) {
        admin = await issueHostAdminLease([...ADMIN_OPERATIONS], 600, channel.transport)
        identity.assertActive()
        adminLeases.set(channel.transport, {
          lease: admin,
          account: identity.account,
          hostConfig: identity.hostConfig,
        })
      }
      identity.assertActive()
      try {
        const result = await channel.transport.call<T>(name, { ...args, adminLease: admin.token })
        identity.assertActive()
        return result
      } catch (error) {
        if (isInvalidAdminLease(error) && adminLeases.get(channel.transport)?.lease === admin) {
          adminLeases.delete(channel.transport)
        }
        throw error
      }
    })
  } finally {
    identity.dispose()
  }
}

export const managedDesktopClient = {
  list: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopResource[]>(target, "managed_desktop_list", {}),
  listConfigs: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopConfigSummary[]>(target, "managed_desktop_list_configs", {}),
  quote: (target: ManagedDesktopTarget, providerConfigId: string, lifetimeSeconds: number) =>
    call<ManagedDesktopQuote>(target, "managed_desktop_quote", {
      providerConfigId,
      lifetimeSeconds,
    }),
  authorize: (
    target: ManagedDesktopTarget,
    providerConfigId: string,
    quoteId: string,
    action: "create" | "prepareTemplate"
  ) =>
    call<ManagedDesktopAuthorization>(target, "managed_desktop_authorize", {
      providerConfigId,
      quoteId,
      action,
    }),
  prepareTemplate: (target: ManagedDesktopTarget, request: ManagedDesktopCreation) =>
    call<ManagedDesktopConfigSummary>(target, "managed_desktop_prepare_template", { ...request }),
  create: (target: ManagedDesktopTarget, request: ManagedDesktopCreation) =>
    call<ManagedDesktopResource>(target, "managed_desktop_create", { ...request }),
  connect: (target: ManagedDesktopTarget, ref: ManagedDesktopRef) =>
    call<ManagedDesktopResource>(target, "managed_desktop_connect", { ...ref }),
  health: (target: ManagedDesktopTarget, ref: ManagedDesktopRef) =>
    call<ManagedDesktopHealth>(target, "managed_desktop_health", { ...ref }),
  delete: (target: ManagedDesktopTarget, ref: ManagedDesktopRef) =>
    call<ManagedDesktopResource>(target, "managed_desktop_delete", { ...ref }),
}
/** Open once per viewer. Authentication replacement invalidates, never silently rebinds control. */
export async function openManagedDesktop(
  target: ManagedDesktopTarget,
  ref: ManagedDesktopRef
): Promise<SandboxDesktopSession> {
  const account = useAccountStore.getState().unlockedAccountId
  if (!account || useAccountStore.getState().locked)
    throw new Error("managed_desktop_authentication_required")
  if (target.kind === "remote" && !target.hostId.trim())
    throw new Error("managed desktop host is required")
  const listeners = new Set<() => void>()
  let invalid = false
  const invalidate = () => {
    if (invalid) return
    invalid = true
    for (const handler of listeners) handler()
  }
  const identity = managedDesktopIdentityScope(target, invalidate)
  let channel: Awaited<ReturnType<typeof acquireManagementChannel>> | null = null
  try {
    identity.assertActive()
    channel = target.kind === "remote" ? await acquireManagementChannel(target.hostId) : null
    identity.assertActive()
    if (channel) identity.assertChannel(channel.host.config)
  } catch (error) {
    channel?.release()
    identity.dispose()
    throw error
  }
  const bound = channel?.transport ?? localTransport
  const detachers: Array<() => void> = [identity.dispose]
  let closed = false
  let controlAdmin: HostAdminLease | undefined
  const identityCurrent = () => {
    const current = useAccountStore.getState()
    return !current.locked && current.unlockedAccountId === account
  }
  if (channel) {
    const transport = bound as Transport & {
      onConnectionStateChange?: (handler: (state: ConnectionState) => void) => () => void
      onTierChange?: (handler: (tier: TransportTier) => void) => () => void
    }
    let tier: TransportTier | null = null
    let state: ConnectionState = "connected"
    // Reuse the companion's effective state: relay/RTC can work without a websocket.
    const checkConnection = () => {
      if (effectiveConnectionState(state, tier) !== "connected") invalidate()
    }
    if (transport.onTierChange)
      detachers.push(
        transport.onTierChange((next) => {
          tier = next
          checkConnection()
        })
      )
    if (transport.onConnectionStateChange)
      detachers.push(
        transport.onConnectionStateChange((next) => {
          state = next
          checkConnection()
        })
      )
  }
  async function invoke<T>(
    name: string,
    args: Record<string, unknown>,
    cleanup = false
  ): Promise<T> {
    identity.assertActive()
    if ((!cleanup && (invalid || closed)) || !identityCurrent())
      throw new Error("managed_desktop_session_invalidated")
    const request = { ...ref, ...args }
    const dispatch = async (command: string, payload: Record<string, unknown>): Promise<T> => {
      identity.assertActive()
      const result = await bound.call<T>(command, payload)
      identity.assertActive()
      if (!cleanup && (invalid || closed)) throw new Error("managed_desktop_session_invalidated")
      return result
    }
    if (target.kind === "local")
      return dispatch("managed_desktop_local_call", { name, args: request })
    if (name === "managed_desktop_control_acquire") {
      // A management lease is step-up only. It cannot replace the short input lease.
      const admin = await issueHostAdminLease(
        [
          "managed_desktop_control_acquire",
          "managed_desktop_control_renew",
          "managed_desktop_control_release",
          "managed_desktop_control_input",
        ],
        undefined,
        bound
      )
      if (invalid || closed || !identityCurrent())
        throw new Error("managed_desktop_session_invalidated")
      controlAdmin = admin
      return dispatch(name, { ...request, adminLease: admin.token })
    }
    if (
      [
        "managed_desktop_control_renew",
        "managed_desktop_control_release",
        "managed_desktop_control_input",
      ].includes(name)
    ) {
      if (!controlAdmin || controlAdmin.expiresAt <= Date.now())
        throw new Error("managed_desktop_admin_lease_expired")
      return dispatch(name, { ...request, adminLease: controlAdmin.token })
    }
    return dispatch(name, request)
  }
  const proof = (lease: SandboxControlLease) => {
    if (lease.fence === undefined) throw new Error("managed_desktop_missing_fence")
    return { token: lease.token, fence: lease.fence }
  }
  return {
    managed: true,
    status: () => invoke<SandboxDesktopStatus>("managed_desktop_control_status", {}),
    frame: () => invoke<SandboxDesktopFrame>("managed_desktop_control_frame", {}),
    acquire: (takeover) =>
      invoke<SandboxControlLease>("managed_desktop_control_acquire", { takeover }),
    renew: (lease) => invoke<SandboxControlLease>("managed_desktop_control_renew", proof(lease)),
    release: (lease) => invoke<void>("managed_desktop_control_release", proof(lease), true),
    input: (lease, frame, point, action) => {
      if (!frame.frameId || frame.fence !== lease.fence)
        return Promise.reject(new Error("managed_desktop_missing_frame_proof"))
      return invoke<void>("managed_desktop_control_input", {
        ...proof(lease),
        frameId: frame.frameId,
        point,
        action,
      })
    },
    onInvalidated: (handler) => {
      listeners.add(handler)
      if (invalid) handler()
      return () => {
        listeners.delete(handler)
      }
    },
    close: () => {
      if (closed) return
      closed = true
      detachers.forEach((detach) => detach())
      channel?.release()
      listeners.clear()
    },
  }
}

export type ManagedDesktopClient = typeof managedDesktopClient

/** The exact refusal from cognia-companion-security::admin_lease::validate. */
function isInvalidAdminLease(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined
  return message === "REMOTE_CONSENT_REQUIRED: admin lease is invalid or expired"
}

/** Only known Host refusal codes become UI text; never render provider response bodies. */
export function managedDesktopErrorKey(error: unknown): string {
  if (error instanceof HostConsentRequiredError || isInvalidAdminLease(error))
    return "humanRequired"
  const codes: Record<string, string> = {
    managed_desktop_policy_limit: "policyLimit",
    managed_desktop_entitlement_limit: "entitlementLimit",
    managed_desktop_entitlement_unknown: "entitlementUnknown",
    managed_desktop_price_unknown: "priceUnknown",
    managed_desktop_unqualified: "unqualified",
    managed_desktop_egress_smoke_unsupported: "egressSmokeUnsupported",
    managed_desktop_human_authorization_required: "humanRequired",
    managed_desktop_host_consent_required: "humanRequired",
    managed_desktop_authorization_expired: "quoteExpired",
    quote_expired: "quoteExpired",
    authorization_expired: "quoteExpired",
  }
  const candidates =
    typeof error === "string"
      ? [error]
      : error && typeof error === "object"
        ? ["code" in error ? error.code : undefined, "message" in error ? error.message : undefined]
        : []
  for (const candidate of candidates) {
    if (typeof candidate === "string" && codes[candidate]) return codes[candidate]
  }
  return "unknown"
}
