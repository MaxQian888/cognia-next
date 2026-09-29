import Dexie from "dexie"

import { accountDatabaseName } from "@/lib/accounts/account-db"
import { activateAccountContentCipher } from "@/lib/accounts/content-cipher"
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
  deleteRuntimeTargetDatabases,
  encryptedRuntimeTargetDatabaseName,
  runtimeTargetDatabaseName,
  type RuntimeTargetRecord,
} from "./target-registry"

interface AccountRuntimeTargetRegistry {
  getActiveTarget(localAccountId: string): Promise<RuntimeTargetRecord | null>
  ensureStandaloneTarget(localAccountId: string): Promise<RuntimeTargetRecord>
  activateTarget(localAccountId: string, targetId: string): Promise<RuntimeTargetRecord>
  listTargets(localAccountId: string): Promise<RuntimeTargetRecord[]>
  deleteTarget(localAccountId: string, targetId: string): Promise<void>
  deleteAccountTargets(localAccountId: string): Promise<void>
}

interface PrepareDependencies {
  registry: AccountRuntimeTargetRegistry
  migrate(input: {
    accountId: string
    targetId: string
  }): Promise<{ stage: "verified"; tables: unknown[] }>
  markCompleted(localAccountId: string, targetId: string): Promise<void>
  /**
   * Is there still a plaintext database left to fold into the encrypted
   * target? Injected so the steady-state skip is testable without Dexie.
   */
  hasPendingMigration?(input: { accountId: string; targetId: string }): Promise<boolean>
}

interface RemoveDependencies {
  registry: AccountRuntimeTargetRegistry
  deleteDatabase(name: string): Promise<void>
  databaseExists?(name: string): Promise<boolean>
}

interface SwitchDependencies {
  registry: AccountRuntimeTargetRegistry
  hasRunningStandaloneTurn(): boolean
  activateDatabase(localAccountId: string, targetId: string): void
  setContext(localAccountId: string, targetId: string): void
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
  activateDatabase(localAccountId: string, targetId: string): void
  setContext(localAccountId: string, targetId: string): void
  finalizeCaptures?(context: {
    accountId: string
    fromTargetId: string | null
    toTargetId: string
  }): Promise<void>
  stopSubscriptions(): Promise<void>
  deleteDatabase(name: string): Promise<void>
  databaseExists?(name: string): Promise<boolean>
}

interface RegisterDependencies {
  registry: Pick<RuntimeTargetRegistry, "upsertAndActivateCompanionTarget">
  getContext(): RuntimeTargetScope | null
  activateDatabase(localAccountId: string, targetId: string): void
  setContext(localAccountId: string, targetId: string): void
}

const runtimeTargetRegistry = new RuntimeTargetRegistry()

async function migrateEncryptedRuntimeTarget(input: {
  accountId: string
  targetId: string
}): Promise<{ stage: "verified"; tables: unknown[] }> {
  const vault = getActiveBrowserVault()
  if (!vault || vault.accountId !== input.accountId) {
    throw new Error("Browser Vault must be unlocked before account content migration.")
  }
  const targetDbName = encryptedRuntimeTargetDatabaseName(input.accountId, input.targetId)
  activateAccountContentCipher(vault.createContentCipher(targetDbName))
  const legacyTargetDbName = runtimeTargetDatabaseName(input.accountId, input.targetId)
  const sourceDbName = (await Dexie.exists(legacyTargetDbName))
    ? legacyTargetDbName
    : accountDatabaseName(input.accountId)
  const result = await migrateAccountDatabaseToTarget({
    ...input,
    sourceDbName,
    targetDbName,
  })
  if (await Dexie.exists(sourceDbName)) {
    await Dexie.delete(sourceDbName)
    if (await Dexie.exists(sourceDbName)) {
      throw new Error(`Plaintext account database deletion could not be verified: ${sourceDbName}`)
    }
  }
  return result
}

/**
 * Cheap steady-state probe: two `Dexie.exists` calls, no database is opened.
 *
 * Migration is a ONE-TIME fold of a plaintext database into its encrypted
 * replacement, but it sat on the unlock path with no guard — so every unlock
 * of an already-migrated account re-activated the cipher, opened the journal
 * plus both databases and wrote a full `copying`→`verified` cycle to copy
 * nothing, during the stage the lock screen already calls the long pole. It
 * also made an unlocked Vault a hard precondition for a path that previously
 * needed none.
 */
async function plaintextSourceExists(input: {
  accountId: string
  targetId: string
}): Promise<boolean> {
  return (
    (await Dexie.exists(runtimeTargetDatabaseName(input.accountId, input.targetId))) ||
    (await Dexie.exists(accountDatabaseName(input.accountId)))
  )
}

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
  localAccountId: string,
  dependencies: PrepareDependencies = {
    registry: runtimeTargetRegistry,
    migrate: migrateEncryptedRuntimeTarget,
    markCompleted: markTargetDatabaseMigrationCompleted,
  }
): Promise<RuntimeTargetRecord> {
  const active = await dependencies.registry.getActiveTarget(localAccountId)
  if (active) {
    const pending = await (dependencies.hasPendingMigration ?? plaintextSourceExists)({
      accountId: localAccountId,
      targetId: active.id,
    })
    if (pending) {
      await dependencies.migrate({ accountId: localAccountId, targetId: active.id })
      await dependencies.markCompleted(localAccountId, active.id)
    }
    return active
  }

  const target = await dependencies.registry.ensureStandaloneTarget(localAccountId)
  await dependencies.migrate({ accountId: localAccountId, targetId: target.id })
  const activated = await dependencies.registry.activateTarget(localAccountId, target.id)
  await dependencies.markCompleted(localAccountId, target.id)
  return activated
}

export async function removeAccountRuntimeTargets(
  localAccountId: string,
  dependencies: RemoveDependencies = {
    registry: runtimeTargetRegistry,
    deleteDatabase: (name) => Dexie.delete(name),
  }
): Promise<RuntimeTargetDeletionResult> {
  const targets = await dependencies.registry.listTargets(localAccountId)
  const deletedDatabases: string[] = []
  const databaseExists = dependencies.databaseExists ?? ((name: string) => Dexie.exists(name))
  for (const target of targets) {
    deletedDatabases.push(
      ...(await deleteRuntimeTargetDatabases(localAccountId, target.id, {
        deleteDatabase: dependencies.deleteDatabase,
        databaseExists,
      }))
    )
  }
  await dependencies.registry.deleteAccountTargets(localAccountId)
  const remainingTargets = await dependencies.registry.listTargets(localAccountId)
  if (remainingTargets.length > 0) {
    throw new Error(
      `Runtime target registry deletion could not be verified for ${localAccountId}: ${remainingTargets.length} row(s) remain.`
    )
  }
  return {
    accountId: localAccountId,
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
  },
  isCurrent?: () => boolean
): Promise<RuntimeTargetRecord | null> {
  const scope = dependencies.getContext()
  const localAccountId = config.accountId ?? scope?.accountId
  if (!localAccountId) return null
  const targetId = config.targetId ?? (await deriveCompanionRuntimeTargetId(config))
  if (isCurrent && !isCurrent()) return null
  const hostname = new URL(config.baseUrl).hostname
  const input = {
    accountId: localAccountId,
    id: targetId,
    label: hostname,
    hostKind:
      classifyWsHost(config.baseUrl) === "ws-lan" ? ("desktop" as const) : ("cloud" as const),
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    serverVersion: config.serverVersion,
    serverFingerprint: config.serverFingerprint,
    credentialRef: `companion-host:${encodeURIComponent(localAccountId)}:${encodeURIComponent(targetId)}:device-private-jwk`,
  }
  const activated = isCurrent
    ? await dependencies.registry.upsertAndActivateCompanionTarget(input, isCurrent)
    : await dependencies.registry.upsertAndActivateCompanionTarget(input)
  if (isCurrent && !isCurrent()) return null
  dependencies.activateDatabase(localAccountId, activated.id)
  dependencies.setContext(localAccountId, activated.id)
  return activated
}

export async function switchAccountRuntimeTarget(
  localAccountId: string,
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
        accountId: scope?.accountId ?? localAccountId,
        fromTargetId: scope?.targetId ?? null,
        // The destination is this call's `targetId`. `toTargetId` is the field
        // name on `RuntimeTargetTransitionContext`, not a binding in scope —
        // written as shorthand it was an undeclared identifier, so every switch
        // that used the default dependencies (the menu's "This browser" row and
        // `removeCompanionHost`) died with a ReferenceError before it could
        // activate anything.
        toTargetId: targetId,
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
  const previous = await dependencies.registry.getActiveTarget(localAccountId)
  const target = (await dependencies.registry.listTargets(localAccountId)).find(
    (candidate) => candidate.id === targetId
  )
  if (!target) {
    throw new Error(`Runtime target ${targetId} does not exist for account ${localAccountId}.`)
  }
  if (previous?.id === target.id) return target
  await dependencies.assertCredentialAvailable(target)

  const transition = {
    accountId: localAccountId,
    fromTargetId: previous?.id ?? null,
    toTargetId: target.id,
  }
  await dependencies.finalizeCaptures?.(transition)
  await dependencies.stopSubscriptions()
  const activated = await dependencies.registry.activateTarget(localAccountId, target.id)
  dependencies.activateDatabase(localAccountId, activated.id)
  dependencies.setContext(localAccountId, activated.id)
  try {
    await dependencies.reloadTransport()
    return activated
  } catch (error) {
    if (previous) {
      await dependencies.registry.activateTarget(localAccountId, previous.id)
      dependencies.activateDatabase(localAccountId, previous.id)
      dependencies.setContext(localAccountId, previous.id)
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
  // The detached target's encrypted database — the one this window ran against
  // — and its Router + Fusion ledger go with the plaintext name.
  await deleteRuntimeTargetDatabases(scope.accountId, active.id, {
    deleteDatabase: dependencies.deleteDatabase,
    databaseExists: dependencies.databaseExists ?? ((name) => Dexie.exists(name)),
  })
  return activated
}
