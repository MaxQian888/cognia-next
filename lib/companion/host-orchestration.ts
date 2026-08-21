"use client"

import { classifyWsHost } from "@/lib/connectivity/lan-classify"
import { activateAccountDatabase, clearAccountDatabaseSelection } from "@/lib/db/schema"
import type { Platform } from "@/lib/platform/detect"
import {
  runtimeHostSnapshotFromManifest,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import {
  runRuntimeTargetTransitionPhase,
  type RuntimeTargetTransitionPhase,
} from "@/lib/runtime/runtime-target-lifecycle"
import {
  RuntimeTargetRegistry,
  type RuntimeTargetRecord,
  type UpsertCompanionTargetInput,
} from "@/lib/runtime/target-registry"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { transport } from "@/lib/tauri"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import {
  reloadCompanionConfigForActiveTarget,
  suspendCompanionTransport,
} from "@/lib/tauri/transport-companion"
import {
  companionHostCredentialFromConfig,
  companionHostDraftFromConfig,
  companionCredentialBook,
  hostKeyOf,
  toCompanionConfig,
  type CompanionCredentialBook,
  type CompanionHostRecord,
} from "./credential-book"
import type { HostRuntimeSnapshot, RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { restartMobileHostBindings } from "./mobile-host-binding-lifecycle"
import { restartWebHostBindings } from "./web-host-binding-lifecycle"

export type CompanionClientPlatform = Extract<Platform, "web" | "mobile">

interface HostRuntimeTargetRegistry {
  getActiveTarget(accountId: string): Promise<RuntimeTargetRecord | null>
  listTargets(accountId: string): Promise<RuntimeTargetRecord[]>
  upsertCompanionTarget(input: UpsertCompanionTargetInput): Promise<RuntimeTargetRecord>
  activateTarget(accountId: string, targetId: string): Promise<RuntimeTargetRecord>
}

export interface HostOrchestrationDependencies {
  book: CompanionCredentialBook
  registry: HostRuntimeTargetRegistry
  runPhase(
    phase: RuntimeTargetTransitionPhase,
    context: {
      accountId: string
      fromTargetId: string | null
      toTargetId: string
    }
  ): Promise<void>
  activateDatabase(accountId: string, targetId: string): void
  setContext(accountId: string, targetId: string): void
  reloadTransport(): Promise<CompanionConfig | null>
  negotiateHost(config: CompanionConfig, record: CompanionHostRecord): Promise<HostRuntimeSnapshot>
  authoritativeSync(): Promise<void>
  rebindHostServices(record: CompanionHostRecord, platform: CompanionClientPlatform): Promise<void>
  publishSnapshot(snapshot: RuntimeSnapshot): void
  enterOffline(error: AggregateError): Promise<void>
}

export interface SwitchCompanionHostInput {
  accountId: string
  hostId: string
  platform: CompanionClientPlatform
  /** Re-negotiate an updated credential even when the stable Host is unchanged. */
  force?: boolean
}

export interface PairAndActivateCompanionHostInput {
  accountId: string
  platform: CompanionClientPlatform
  config: CompanionConfig
}

let transitionTail: Promise<unknown> = Promise.resolve()

export function switchCompanionHost(
  input: SwitchCompanionHostInput,
  dependencies?: HostOrchestrationDependencies
): Promise<CompanionHostRecord> {
  const run = async () => {
    const ownedRegistry = dependencies ? null : new RuntimeTargetRegistry()
    const deps = dependencies ?? productionDependencies(ownedRegistry!)
    try {
      return await switchCompanionHostNow(input, deps)
    } finally {
      ownedRegistry?.close()
    }
  }
  const next = transitionTail.then(run, run)
  transitionTail = next.catch(() => undefined)
  return next
}

/** Persist a newly registered device identity, then activate its stable Host. */
export async function pairAndActivateCompanionHost(
  input: PairAndActivateCompanionHostInput,
  dependencies?: HostOrchestrationDependencies
): Promise<CompanionHostRecord> {
  if (!input.config.targetId) throw new Error("Pairing response is missing the stable Host id.")
  const ownedRegistry = dependencies ? null : new RuntimeTargetRegistry()
  const deps = dependencies ?? productionDependencies(ownedRegistry!)
  const key = { accountNamespace: input.accountId, hostId: input.config.targetId }
  const [existing, existingCredential, previousHost] = await Promise.all([
    deps.book.get(key),
    deps.book.loadCredential(key),
    deps.book.getActive(input.accountId),
  ])
  try {
    await deps.book.saveCredential(key, companionHostCredentialFromConfig(input.config))
    const record = await deps.book.upsert(
      companionHostDraftFromConfig(
        { ...input.config, accountId: input.accountId },
        input.accountId,
        existing
      )
    )
    await deps.registry.upsertCompanionTarget(runtimeTargetInput(record))
    return await switchCompanionHostNow(
      { accountId: input.accountId, hostId: record.hostId, platform: input.platform, force: true },
      deps
    )
  } catch (error) {
    // A re-pair replaces the same stable Host. Restore the previous record and
    // secret so a failed activation never destroys the working identity.
    if (existing) {
      await deps.book.upsert(existing)
      if (existingCredential) await deps.book.saveCredential(key, existingCredential)
    } else {
      await deps.book.remove(key)
    }
    if (previousHost) await deps.book.setActive(hostKeyOf(previousHost))
    if (existing && previousHost?.hostId === existing.hostId) {
      try {
        const restored = await deps.reloadTransport()
        if (!restored || restored.targetId !== existing.hostId) {
          throw new Error(
            "The previous Host credential could not be reloaded after re-pair failure."
          )
        }
        const host = await deps.negotiateHost(restored, existing)
        if (!host.compatible) throw new Error("The previous Host is no longer compatible.")
        await deps.authoritativeSync()
        await deps.rebindHostServices(existing, input.platform)
        deps.publishSnapshot(snapshotFor(existing, input.platform, "online", host))
      } catch (restoreError) {
        const aggregate = new AggregateError(
          [error, restoreError],
          "Companion re-pair failed and the previous Host could not be restored."
        )
        await deps.enterOffline(aggregate)
        throw aggregate
      }
    }
    throw error
  } finally {
    ownedRegistry?.close()
  }
}

async function switchCompanionHostNow(
  input: SwitchCompanionHostInput,
  deps: HostOrchestrationDependencies
): Promise<CompanionHostRecord> {
  const key = { accountNamespace: input.accountId, hostId: input.hostId }
  const [record, credential, previousHost, previousTarget] = await Promise.all([
    deps.book.get(key),
    deps.book.loadCredential(key),
    deps.book.getActive(input.accountId),
    deps.registry.getActiveTarget(input.accountId),
  ])
  if (!record) throw new Error(`Companion Host ${input.hostId} is not paired.`)
  if (!credential) throw new Error(`Companion Host ${input.hostId} credential is unavailable.`)
  await toCompanionConfig(record, credential)
  if (
    !input.force &&
    previousHost?.hostId === record.hostId &&
    previousTarget?.id === record.hostId
  ) {
    return record
  }

  const targets = await deps.registry.listTargets(input.accountId)
  if (!targets.some((target) => target.id === record.hostId)) {
    await deps.registry.upsertCompanionTarget(runtimeTargetInput(record))
  }

  const transition = {
    accountId: input.accountId,
    fromTargetId: previousTarget?.id ?? previousHost?.hostId ?? null,
    toTargetId: record.hostId,
  }
  await deps.runPhase("finalize-captures", transition)
  await deps.runPhase("release-subscriptions", transition)

  try {
    await activate(record, input.platform, deps)
    return record
  } catch (activationError) {
    try {
      await rollback(previousHost, previousTarget, input.platform, deps)
    } catch (rollbackError) {
      const aggregate = new AggregateError(
        [activationError, rollbackError],
        "Companion Host activation failed and rollback was incomplete."
      )
      await deps.enterOffline(aggregate)
      throw aggregate
    }
    throw activationError
  }
}

async function activate(
  record: CompanionHostRecord,
  platform: CompanionClientPlatform,
  deps: HostOrchestrationDependencies
): Promise<void> {
  await deps.book.setActive(hostKeyOf(record))
  await deps.registry.activateTarget(record.accountNamespace, record.hostId)
  deps.activateDatabase(record.accountNamespace, record.hostId)
  deps.setContext(record.accountNamespace, record.hostId)
  deps.publishSnapshot(snapshotFor(record, platform, "connecting"))

  const config = await deps.reloadTransport()
  if (!config || config.targetId !== record.hostId) {
    throw new Error(`Companion transport did not activate Host ${record.hostId}.`)
  }
  const host = await deps.negotiateHost(config, record)
  if (!host.compatible) throw new Error(`Companion Host ${record.hostId} is incompatible.`)
  await deps.authoritativeSync()
  await deps.rebindHostServices(record, platform)
  deps.publishSnapshot(snapshotFor(record, platform, "online", host))
}

async function rollback(
  previousHost: CompanionHostRecord | null,
  previousTarget: RuntimeTargetRecord | null,
  platform: CompanionClientPlatform,
  deps: HostOrchestrationDependencies
): Promise<void> {
  if (previousHost) await deps.book.setActive(hostKeyOf(previousHost))
  else if (deps.book.clearActive)
    await deps.book.clearActive(previousTarget?.accountId ?? "", undefined)

  if (!previousTarget) throw new Error("No previous runtime target is available for rollback.")
  await deps.registry.activateTarget(previousTarget.accountId, previousTarget.id)
  deps.activateDatabase(previousTarget.accountId, previousTarget.id)
  deps.setContext(previousTarget.accountId, previousTarget.id)

  const config = await deps.reloadTransport()
  if (previousTarget.kind === "companion") {
    if (!previousHost || !config || config.targetId !== previousHost.hostId) {
      throw new Error("Previous Companion Host could not be restored.")
    }
    const host = await deps.negotiateHost(config, previousHost)
    if (!host.compatible) throw new Error("Previous Companion Host is no longer compatible.")
    await deps.authoritativeSync()
    await deps.rebindHostServices(previousHost, platform)
    deps.publishSnapshot(snapshotFor(previousHost, platform, "online", host))
    return
  }
  deps.publishSnapshot({
    target: { id: previousTarget.id, kind: previousTarget.kind, platform },
    vaultState: "unlocked",
    connectionState: "online",
  })
}

function productionDependencies(registry: RuntimeTargetRegistry): HostOrchestrationDependencies {
  return {
    book: companionCredentialBook(),
    registry,
    runPhase: runRuntimeTargetTransitionPhase,
    activateDatabase: activateAccountDatabase,
    setContext: setActiveRuntimeTargetContext,
    // Host services are rebound explicitly after manifest negotiation and
    // authoritative sync. Suppress the generic config event here so it cannot
    // race that ordered transition; direct endpoint refreshes still notify.
    reloadTransport: () => reloadCompanionConfigForActiveTarget({ notify: false }),
    negotiateHost: async () =>
      runtimeHostSnapshotFromManifest(await transport.call("host_feature_manifest", {})),
    // The outcomes array is the sync's own detail; this seam only promises that
    // the pass completed.
    authoritativeSync: async () => {
      await runSyncDown()
    },
    // `reloadCompanionConfigForActiveTarget` synchronously emits the existing
    // config-changed lifecycle event. Web/Mobile boot providers own the actual
    // Host-bound installers and complete their teardown before this transition.
    rebindHostServices: async (_record, platform) => {
      if (platform === "mobile") await restartMobileHostBindings()
      else await restartWebHostBindings()
    },
    publishSnapshot: setRuntimeSnapshot,
    enterOffline: async () => {
      clearActiveRuntimeTargetContext()
      clearAccountDatabaseSelection()
      await suspendCompanionTransport()
      setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
    },
  }
}

function runtimeTargetInput(record: CompanionHostRecord): UpsertCompanionTargetInput {
  return {
    accountId: record.accountNamespace,
    id: record.hostId,
    label: record.label,
    hostKind: classifyWsHost(record.endpoints.baseUrl) === "ws-lan" ? "desktop" : "cloud",
    baseUrl: record.endpoints.baseUrl,
    deviceId: record.deviceId,
    serverVersion: record.serverVersion,
    serverFingerprint: record.tlsPin ?? undefined,
    credentialRef: `companion-host:${encodeURIComponent(record.accountNamespace)}:${encodeURIComponent(record.hostId)}:device-private-jwk`,
  }
}

function snapshotFor(
  record: CompanionHostRecord,
  platform: CompanionClientPlatform,
  connectionState: "connecting" | "online",
  host?: HostRuntimeSnapshot
): RuntimeSnapshot {
  return {
    target: {
      id: record.hostId,
      kind: "companion",
      platform,
      hostKind: classifyWsHost(record.endpoints.baseUrl) === "ws-lan" ? "desktop" : "cloud",
    },
    vaultState: "unlocked",
    connectionState,
    host,
  }
}
