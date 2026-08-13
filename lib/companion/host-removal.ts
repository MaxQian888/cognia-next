"use client"

import Dexie from "dexie"

import { removeRecentServer } from "@/lib/connectivity/recent-servers"
import { clearAccountDatabaseSelection } from "@/lib/db/schema"
import { clearActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { runRuntimeTargetTransitionPhase } from "@/lib/runtime/runtime-target-lifecycle"
import { switchAccountRuntimeTarget } from "@/lib/runtime/account-runtime-target"
import {
  DEFAULT_STANDALONE_TARGET_ID,
  RuntimeTargetRegistry,
  runtimeTargetDatabaseName,
} from "@/lib/runtime/target-registry"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { suspendCompanionTransport } from "@/lib/tauri/transport-companion"
import {
  companionCredentialBook,
  hostKeyOf,
  toCompanionConfig,
  type CompanionCredentialBook,
} from "./credential-book"
import { revokeCompanionDevice } from "./device-revocation"
import { switchCompanionHost, type CompanionClientPlatform } from "./host-orchestration"

export interface RemoveCompanionHostInput {
  accountId: string
  hostId: string
  platform: CompanionClientPlatform
  fallbackHostId?: string
}

export interface HostRemovalDependencies {
  book: CompanionCredentialBook
  switchHost(input: {
    accountId: string
    hostId: string
    platform: CompanionClientPlatform
  }): Promise<unknown>
  switchWebStandalone(accountId: string): Promise<unknown>
  quiesceSoleMobile(accountId: string, hostId: string): Promise<void>
  revoke: typeof revokeCompanionDevice
  deleteRuntimeTarget(accountId: string, hostId: string): Promise<void>
  deleteActiveRuntimeTarget(accountId: string, hostId: string): Promise<void>
  deleteDatabase(name: string): Promise<void>
  databaseExists(name: string): Promise<boolean>
  removeRecentAlias(baseUrl: string): void
  enterUnpaired(): Promise<void>
}

/** Remote-first completion: no local record is erased until revocation is confirmed. */
export async function removeCompanionHost(
  input: RemoveCompanionHostInput,
  dependencies?: HostRemovalDependencies
): Promise<void> {
  const registry = dependencies ? null : new RuntimeTargetRegistry()
  const deps = dependencies ?? productionDependencies(registry!)
  try {
    const key = { accountNamespace: input.accountId, hostId: input.hostId }
    const [record, credential, active, hosts] = await Promise.all([
      deps.book.get(key),
      deps.book.loadCredential(key),
      deps.book.getActive(input.accountId),
      deps.book.list(input.accountId),
    ])
    if (!record) throw new Error(`Companion Host ${input.hostId} is not paired.`)
    if (!credential) throw new Error(`Companion Host ${input.hostId} credential is unavailable.`)
    const removingActive = active?.hostId === record.hostId
    const alternatives = hosts.filter((host) => host.hostId !== record.hostId)

    if (removingActive && alternatives.length > 0) {
      if (!input.fallbackHostId) throw new Error("A fallback Host is required before removal.")
      if (!alternatives.some((host) => host.hostId === input.fallbackHostId)) {
        throw new Error("The selected fallback Host is not paired.")
      }
      await deps.switchHost({
        accountId: input.accountId,
        hostId: input.fallbackHostId,
        platform: input.platform,
      })
    } else if (removingActive && input.platform === "web") {
      await deps.switchWebStandalone(input.accountId)
    } else if (removingActive) {
      await deps.quiesceSoleMobile(input.accountId, input.hostId)
    }

    const config = await toCompanionConfig(record, credential)
    await deps.revoke(config)

    // Only confirmed revocation reaches this point. Target DB deletion removes
    // mirrors, cursors, pending/sending/retry/dead-letter queue rows together.
    if (removingActive && input.platform === "mobile" && alternatives.length === 0) {
      await deps.book.clearActive?.(input.accountId, input.hostId)
      await deps.deleteActiveRuntimeTarget(input.accountId, input.hostId)
    } else {
      await deps.deleteRuntimeTarget(input.accountId, input.hostId)
    }
    const databaseName = runtimeTargetDatabaseName(input.accountId, input.hostId)
    await deps.deleteDatabase(databaseName)
    if (await deps.databaseExists(databaseName)) {
      throw new Error(`Companion Host database deletion could not be verified: ${databaseName}`)
    }
    await deps.book.remove(hostKeyOf(record))
    deps.removeRecentAlias(record.endpoints.baseUrl)

    if (removingActive && input.platform === "mobile" && alternatives.length === 0) {
      await deps.enterUnpaired()
    }
  } finally {
    registry?.close()
  }
}

function productionDependencies(registry: RuntimeTargetRegistry): HostRemovalDependencies {
  return {
    book: companionCredentialBook(),
    switchHost: switchCompanionHost,
    switchWebStandalone: (accountId) =>
      switchAccountRuntimeTarget(accountId, DEFAULT_STANDALONE_TARGET_ID),
    quiesceSoleMobile: async (accountId, hostId) => {
      const transition = { accountId, fromTargetId: hostId, toTargetId: "mobile-unpaired" }
      await runRuntimeTargetTransitionPhase("finalize-captures", transition)
      await runRuntimeTargetTransitionPhase("release-subscriptions", transition)
    },
    revoke: revokeCompanionDevice,
    deleteRuntimeTarget: (accountId, hostId) => registry.deleteTarget(accountId, hostId),
    deleteActiveRuntimeTarget: (accountId, hostId) =>
      registry.deleteActiveTarget(accountId, hostId),
    deleteDatabase: (name) => Dexie.delete(name),
    databaseExists: (name) => Dexie.exists(name),
    removeRecentAlias: removeRecentServer,
    enterUnpaired: async () => {
      clearActiveRuntimeTargetContext()
      clearAccountDatabaseSelection()
      await suspendCompanionTransport()
      setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
    },
  }
}
