import Dexie from "dexie"

import { classifyWsHost } from "@/lib/connectivity/lan-classify"
import { activateAccountDatabase } from "@/lib/db/schema"
import { getExecutionBroker } from "@/lib/execution/broker"
import { getActiveBrowserVault } from "./browser-vault"
import { getRuntimeSnapshot } from "./runtime-snapshot-store"
import {
  markTargetDatabaseMigrationCompleted,
  migrateAccountDatabaseToTarget,
} from "./target-database-migration"
import {
  getActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "./runtime-target-context"
import {
  runRuntimeTargetTransitionPhase,
  stopRuntimeTargetSubscriptions,
} from "./runtime-target-lifecycle"
import {
  RuntimeTargetRegistry,
  runtimeTargetDatabaseName,
  type RuntimeTargetRecord,
} from "./target-registry"

interface AccountRuntimeTargetRegistry {
  getActiveTarget(accountId: string): Promise<RuntimeTargetRecord | null>
  ensureStandaloneTarget(accountId: string): Promise<RuntimeTargetRecord>
  activateTarget(accountId: string, targetId: string): Promise<RuntimeTargetRecord>
  listTargets(accountId: string): Promise<RuntimeTargetRecord[]>
  deleteTarget(accountId: string, targetId: string): Promise<void>
  deleteAccountTargets(accountId: string): Promise<void>
}

interface PrepareDependencies {
  registry: AccountRuntimeTargetRegistry
  migrate(input: {
    accountId: string
    targetId: string
  }): Promise<{ stage: "verified"; tables: unknown[] }>
  markCompleted(accountId: string, targetId: string): Promise<void>
}

interface RemoveDependencies {
  registry: AccountRuntimeTargetRegistry
  deleteDatabase(name: string): Promise<void>
  databaseExists?(name: string): Promise<boolean>
}

interface SwitchDependencies {
  registry: AccountRuntimeTargetRegistry
  hasRunningStandaloneTurn(): boolean
  activateDatabase(accountId: string, targetId: string): void
  setContext(accountId: string, targetId: string): void
  assertCredentialAvailable(target: RuntimeTargetRecord): Promise<void>
  finalizeCaptures?(context: {
    accountId: string
    fromTargetId: string | null
    toTargetId: string
  }): Promise<void>
  stopSubscriptions(): Promise<void>
  reloadTransport(): Promise<unknown>
}

interface DetachDependencies {
  registry: AccountRuntimeTargetRegistry
  activateDatabase(accountId: string, targetId: string): void
  setContext(accountId: string, targetId: string): void
  finalizeCaptures?(context: {
    accountId: string
    fromTargetId: string | null
    toTargetId: string
  }): Promise<void>
  stopSubscriptions(): Promise<void>
  deleteDatabase(name: string): Promise<void>
}

interface RegisterDependencies {
  registry: Pick<RuntimeTargetRegistry, "upsertAndActivateCompanionTarget">
  getContext(): RuntimeTargetScope | null
  activateDatabase(accountId: string, targetId: string): void
  setContext(accountId: string, targetId: string): void
}

const runtimeTargetRegistry = new RuntimeTargetRegistry()

export interface CompanionRuntimeConfigMetadata {
  baseUrl: string
  deviceId: string
  serverVersion: string
  serverFingerprint?: string
  targetId?: string
  /** Account captured when pairing began; avoids re-reading mutable boot context after persistence. */
  accountId?: string
}

export async function prepareAccountRuntimeTarget(
  accountId: string,
  dependencies: PrepareDependencies = {
    registry: runtimeTargetRegistry,
    migrate: migrateAccountDatabaseToTarget,
    markCompleted: markTargetDatabaseMigrationCompleted,
  }
): Promise<RuntimeTargetRecord> {
  const active = await dependencies.registry.getActiveTarget(accountId)
  if (active) return active

  const target = await dependencies.registry.ensureStandaloneTarget(accountId)
  await dependencies.migrate({ accountId, targetId: target.id })
  const activated = await dependencies.registry.activateTarget(accountId, target.id)
  await dependencies.markCompleted(accountId, target.id)
  return activated
}

export async function removeAccountRuntimeTargets(
  accountId: string,
  dependencies: RemoveDependencies = {
    registry: runtimeTargetRegistry,
    deleteDatabase: (name) => Dexie.delete(name),
  }
): Promise<RuntimeTargetDeletionResult> {
  const targets = await dependencies.registry.listTargets(accountId)
  const deletedDatabases: string[] = []
  for (const target of targets) {
    const databaseName = runtimeTargetDatabaseName(accountId, target.id)
    await dependencies.deleteDatabase(databaseName)
    const databaseExists = dependencies.databaseExists ?? ((name: string) => Dexie.exists(name))
    if (await databaseExists(databaseName)) {
      throw new Error(`Runtime target database deletion could not be verified: ${databaseName}`)
    }
    deletedDatabases.push(databaseName)
  }
  await dependencies.registry.deleteAccountTargets(accountId)
  const remainingTargets = await dependencies.registry.listTargets(accountId)
  if (remainingTargets.length > 0) {
    throw new Error(
      `Runtime target registry deletion could not be verified for ${accountId}: ${remainingTargets.length} row(s) remain.`
    )
  }
  return {
    accountId,
    targetIds: targets.map((target) => target.id),
    deletedDatabases,
    registryRowsDeleted: targets.length,
  }
}

export interface RuntimeTargetDeletionResult {
  accountId: string
  targetIds: string[]
  deletedDatabases: string[]
  registryRowsDeleted: number
}

export async function deriveCompanionRuntimeTargetId(
  config: Pick<CompanionRuntimeConfigMetadata, "baseUrl" | "serverFingerprint">
): Promise<string> {
  const identity = config.serverFingerprint?.trim().toLowerCase() || config.baseUrl
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
  return `companion-${hex.slice(0, 24)}`
}

export async function registerCompanionRuntimeTarget(
  config: CompanionRuntimeConfigMetadata,
  dependencies: RegisterDependencies = {
    registry: runtimeTargetRegistry,
    getContext: getActiveRuntimeTargetContext,
    activateDatabase: activateAccountDatabase,
    setContext: setActiveRuntimeTargetContext,
  }
): Promise<RuntimeTargetRecord | null> {
  const scope = dependencies.getContext()
  const accountId = config.accountId ?? scope?.accountId
  if (!accountId) return null
  const targetId = config.targetId ?? (await deriveCompanionRuntimeTargetId(config))
  const hostname = new URL(config.baseUrl).hostname
  const activated = await dependencies.registry.upsertAndActivateCompanionTarget({
    accountId,
    id: targetId,
    label: hostname,
    hostKind: classifyWsHost(config.baseUrl) === "ws-lan" ? "desktop" : "cloud",
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    serverVersion: config.serverVersion,
    serverFingerprint: config.serverFingerprint,
    credentialRef: `companion-host:${encodeURIComponent(accountId)}:${encodeURIComponent(targetId)}:device-private-jwk`,
  })
  dependencies.activateDatabase(accountId, activated.id)
  dependencies.setContext(accountId, activated.id)
  return activated
}

export async function switchAccountRuntimeTarget(
  accountId: string,
  targetId: string,
  dependencies: SwitchDependencies = {
    registry: runtimeTargetRegistry,
    hasRunningStandaloneTurn: () =>
      getRuntimeSnapshot().target?.kind === "standalone" &&
      getExecutionBroker()
        .list()
        .some((leg) => leg.resource === "ai-turn" && leg.state === "running"),
    activateDatabase: activateAccountDatabase,
    setContext: setActiveRuntimeTargetContext,
    assertCredentialAvailable: async (target) => {
      if (target.kind !== "companion") return
      const vault = getActiveBrowserVault()
      if (!vault || vault.accountId !== target.accountId) {
        throw new Error("Browser Vault must be unlocked before switching to a Companion target.")
      }
      if (!target.credentialRef || !(await vault.loadSecret(target.credentialRef))) {
        throw new Error("Companion target credentials are unavailable.")
      }
    },
    finalizeCaptures: (context) => runRuntimeTargetTransitionPhase("finalize-captures", context),
    stopSubscriptions: async () => {
      const scope = getActiveRuntimeTargetContext()
      await runRuntimeTargetTransitionPhase("release-subscriptions", {
        accountId: scope?.accountId ?? accountId,
        fromTargetId: scope?.targetId ?? null,
        toTargetId,
      })
    },
    reloadTransport: async () => {
      const { reloadCompanionConfigForActiveTarget } =
        await import("@/lib/tauri/transport-companion")
      return reloadCompanionConfigForActiveTarget()
    },
  }
): Promise<RuntimeTargetRecord> {
  if (dependencies.hasRunningStandaloneTurn()) {
    throw new Error("A standalone chat turn must stop or finish before switching runtime targets.")
  }
  const previous = await dependencies.registry.getActiveTarget(accountId)
  const target = (await dependencies.registry.listTargets(accountId)).find(
    (candidate) => candidate.id === targetId
  )
  if (!target) {
    throw new Error(`Runtime target ${targetId} does not exist for account ${accountId}.`)
  }
  if (previous?.id === target.id) return target
  await dependencies.assertCredentialAvailable(target)

  const transition = {
    accountId,
    fromTargetId: previous?.id ?? null,
    toTargetId: target.id,
  }
  await dependencies.finalizeCaptures?.(transition)
  await dependencies.stopSubscriptions()
  const activated = await dependencies.registry.activateTarget(accountId, target.id)
  dependencies.activateDatabase(accountId, activated.id)
  dependencies.setContext(accountId, activated.id)
  try {
    await dependencies.reloadTransport()
    return activated
  } catch (error) {
    if (previous) {
      await dependencies.registry.activateTarget(accountId, previous.id)
      dependencies.activateDatabase(accountId, previous.id)
      dependencies.setContext(accountId, previous.id)
      await dependencies.reloadTransport().catch(() => {})
    }
    throw error
  }
}

/**
 * Remove the active Web Companion target after its credentials have been
 * revoked. The active pointer and physical database are switched first so no
 * repository or queue can continue writing into the detached target.
 */
export async function detachActiveCompanionRuntimeTarget(
  dependencies: DetachDependencies = {
    registry: runtimeTargetRegistry,
    activateDatabase: activateAccountDatabase,
    setContext: setActiveRuntimeTargetContext,
    finalizeCaptures: (context) => runRuntimeTargetTransitionPhase("finalize-captures", context),
    stopSubscriptions: stopRuntimeTargetSubscriptions,
    deleteDatabase: (name) => Dexie.delete(name),
  }
): Promise<RuntimeTargetRecord | null> {
  const scope = getActiveRuntimeTargetContext()
  if (!scope) return null

  const active = await dependencies.registry.getActiveTarget(scope.accountId)
  if (!active || active.id !== scope.targetId || active.kind !== "companion") {
    return active
  }

  const standalone = await dependencies.registry.ensureStandaloneTarget(scope.accountId)
  await dependencies.finalizeCaptures?.({
    accountId: scope.accountId,
    fromTargetId: active.id,
    toTargetId: standalone.id,
  })
  await dependencies.stopSubscriptions()
  const activated = await dependencies.registry.activateTarget(scope.accountId, standalone.id)
  dependencies.activateDatabase(scope.accountId, activated.id)
  dependencies.setContext(scope.accountId, activated.id)
  await dependencies.registry.deleteTarget(scope.accountId, active.id)
  await dependencies.deleteDatabase(runtimeTargetDatabaseName(scope.accountId, active.id))
  return activated
}
