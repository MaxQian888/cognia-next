import Dexie, { type Table } from "dexie"

import { assertAccountId } from "@/lib/accounts/account-types"
import { isLoopbackHostname } from "@/lib/connectivity/loopback-hostname"
import { withFusionDatabase } from "@/lib/router-fusion/gate/database-name"
import type { CompanionRuntimeTarget, RuntimeTarget } from "./runtime-target"

export const RUNTIME_TARGET_REGISTRY_DB_NAME = "cognia-runtime-target-registry"
export const DEFAULT_STANDALONE_TARGET_ID = "web-standalone"
export const LEGACY_MIXED_TARGET_ID = "legacy-mixed"

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/

export interface RuntimeTargetRecord {
  accountId: string
  id: string
  kind: RuntimeTarget["kind"]
  label: string
  hostKind?: CompanionRuntimeTarget["hostKind"]
  baseUrl?: string
  deviceId?: string
  serverVersion?: string
  serverFingerprint?: string
  credentialRef?: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface ActiveRuntimeTargetRecord {
  accountId: string
  targetId: string
  updatedAt: number
}

class RuntimeTargetRegistryDB extends Dexie {
  targets!: Table<RuntimeTargetRecord, [string, string]>
  activeTargets!: Table<ActiveRuntimeTargetRecord, string>

  constructor(name = RUNTIME_TARGET_REGISTRY_DB_NAME) {
    super(name)
    this.version(1).stores({
      targets: "&[accountId+id], accountId, kind, [accountId+lastUsedAt]",
      activeTargets: "&accountId, targetId, updatedAt",
    })
  }
}

export interface AddRuntimeTargetInput {
  accountId: string
  id: string
  kind: RuntimeTargetRecord["kind"]
  label: string
  hostKind?: RuntimeTargetRecord["hostKind"]
  now?: number
}

export interface UpsertCompanionTargetInput {
  accountId: string
  id: string
  label: string
  hostKind: NonNullable<RuntimeTargetRecord["hostKind"]>
  baseUrl: string
  deviceId: string
  serverVersion: string
  serverFingerprint?: string
  credentialRef: string
  now?: number
}

export class RuntimeTargetRegistry {
  constructor(private readonly db: RuntimeTargetRegistryDB = new RuntimeTargetRegistryDB()) {}

  close(): void {
    this.db.close()
  }

  async listTargets(localAccountId: string): Promise<RuntimeTargetRecord[]> {
    assertAccountId(localAccountId)
    return this.db.targets.where("accountId").equals(localAccountId).sortBy("lastUsedAt")
  }

  async getActiveTarget(localAccountId: string): Promise<RuntimeTargetRecord | null> {
    assertAccountId(localAccountId)
    const pointer = await this.db.activeTargets.get(localAccountId)
    if (!pointer) return null
    return (await this.db.targets.get([localAccountId, pointer.targetId])) ?? null
  }

  async ensureStandaloneTarget(
    localAccountId: string,
    now = Date.now()
  ): Promise<RuntimeTargetRecord> {
    assertAccountId(localAccountId)
    const existing = await this.db.targets.get([localAccountId, DEFAULT_STANDALONE_TARGET_ID])
    if (existing) return existing
    return this.addTarget({
      accountId: localAccountId,
      id: DEFAULT_STANDALONE_TARGET_ID,
      kind: "standalone",
      label: "This browser",
      now,
    })
  }

  async addTarget(input: AddRuntimeTargetInput): Promise<RuntimeTargetRecord> {
    const localAccountId = assertAccountId(input.accountId)
    const id = assertTargetId(input.id)
    validateTargetShape(input.kind, input.hostKind)
    const now = input.now ?? Date.now()
    const row: RuntimeTargetRecord = {
      accountId: localAccountId,
      id,
      kind: input.kind,
      label: normalizeLabel(input.label),
      hostKind: input.hostKind,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    await this.db.targets.add(row)
    return row
  }

  async upsertCompanionTarget(input: UpsertCompanionTargetInput): Promise<RuntimeTargetRecord> {
    const localAccountId = assertAccountId(input.accountId)
    const id = assertTargetId(input.id)
    const now = input.now ?? Date.now()
    const existing = await this.db.targets.get([localAccountId, id])
    const row: RuntimeTargetRecord = {
      accountId: localAccountId,
      id,
      kind: "companion",
      label: normalizeLabel(input.label),
      hostKind: input.hostKind,
      baseUrl: normalizeHttpsUrl(input.baseUrl),
      deviceId: input.deviceId,
      serverVersion: input.serverVersion,
      serverFingerprint: input.serverFingerprint,
      credentialRef: input.credentialRef,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? now,
    }
    await this.db.targets.put(row)
    return row
  }

  /** Atomically write and activate a Companion target for a completed pair. */
  async upsertAndActivateCompanionTarget(
    input: UpsertCompanionTargetInput,
    isCurrent?: () => boolean
  ): Promise<RuntimeTargetRecord> {
    const localAccountId = assertAccountId(input.accountId)
    const id = assertTargetId(input.id)
    const now = input.now ?? Date.now()
    let activated: RuntimeTargetRecord | undefined
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const existing = await this.db.targets.get([localAccountId, id])
      if (isCurrent && !isCurrent()) throw new Error("Runtime target activation cancelled")
      activated = companionTargetRow(input, localAccountId, id, now, existing)
      await this.db.targets.put(activated)
      await this.db.activeTargets.put({ accountId: localAccountId, targetId: id, updatedAt: now })
      // Throwing within the transaction rolls both writes back together.
      if (isCurrent && !isCurrent()) throw new Error("Runtime target activation cancelled")
    })
    return activated as RuntimeTargetRecord
  }

  async activateTarget(
    localAccountId: string,
    targetId: string,
    now = Date.now()
  ): Promise<RuntimeTargetRecord> {
    assertAccountId(localAccountId)
    assertTargetId(targetId)
    let activated: RuntimeTargetRecord | undefined
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const target = await this.db.targets.get([localAccountId, targetId])
      if (!target) {
        throw new Error(`Runtime target ${targetId} does not exist for account ${localAccountId}.`)
      }
      activated = { ...target, updatedAt: now, lastUsedAt: now }
      await this.db.targets.put(activated)
      await this.db.activeTargets.put({ accountId: localAccountId, targetId, updatedAt: now })
    })
    return activated as RuntimeTargetRecord
  }

  async ensureDefaultActiveTarget(
    localAccountId: string,
    now = Date.now()
  ): Promise<RuntimeTargetRecord> {
    const active = await this.getActiveTarget(localAccountId)
    if (active) return active
    const standalone = await this.ensureStandaloneTarget(localAccountId, now)
    return this.activateTarget(localAccountId, standalone.id, now)
  }

  async deleteTarget(localAccountId: string, targetId: string): Promise<void> {
    assertAccountId(localAccountId)
    assertTargetId(targetId)
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const active = await this.db.activeTargets.get(localAccountId)
      if (active?.targetId === targetId) {
        throw new Error("The active runtime target must be switched before it can be removed.")
      }
      await this.db.targets.delete([localAccountId, targetId])
    })
  }

  /**
   * Remove the sole active target and its pointer as one transaction.
   * Normal target removal must use `deleteTarget`; this escape hatch exists
   * for Mobile's verified sole-Host revocation, which transitions to unpaired.
   */
  async deleteActiveTarget(localAccountId: string, targetId: string): Promise<void> {
    assertAccountId(localAccountId)
    assertTargetId(targetId)
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const active = await this.db.activeTargets.get(localAccountId)
      if (active?.targetId !== targetId) {
        throw new Error(`Runtime target ${targetId} is not the active runtime target.`)
      }
      await this.db.activeTargets.delete(localAccountId)
      await this.db.targets.delete([localAccountId, targetId])
    })
  }

  async deleteAccountTargets(localAccountId: string): Promise<void> {
    assertAccountId(localAccountId)
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      await this.db.targets.where("accountId").equals(localAccountId).delete()
      await this.db.activeTargets.delete(localAccountId)
    })
  }
}

function companionTargetRow(
  input: UpsertCompanionTargetInput,
  localAccountId: string,
  id: string,
  now: number,
  existing?: RuntimeTargetRecord
): RuntimeTargetRecord {
  return {
    accountId: localAccountId,
    id,
    kind: "companion",
    label: normalizeLabel(input.label),
    hostKind: input.hostKind,
    baseUrl: normalizeHttpsUrl(input.baseUrl),
    deviceId: input.deviceId,
    serverVersion: input.serverVersion,
    serverFingerprint: input.serverFingerprint,
    credentialRef: input.credentialRef,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: now,
  }
}

export function runtimeTargetDatabaseName(localAccountId: string, targetId: string): string {
  return `cognia-account-${assertAccountId(localAccountId)}-target-${assertTargetId(targetId)}`
}

export function encryptedRuntimeTargetDatabaseName(
  localAccountId: string,
  targetId: string
): string {
  return `${runtimeTargetDatabaseName(localAccountId, targetId)}-encrypted-v1`
}

/**
 * Every physical database a runtime target owns, in deletion order: the
 * plaintext name (only ever a migration source in this build), the encrypted
 * database a window actually runs against, and the Router + Fusion ledger
 * beside that encrypted one (ADR-0188 D39). Removing a target deletes all of
 * them, so neither the data nor the ledger rows describing it outlive it.
 */
export function runtimeTargetDatabaseNames(localAccountId: string, targetId: string): string[] {
  return [
    runtimeTargetDatabaseName(localAccountId, targetId),
    ...withFusionDatabase(encryptedRuntimeTargetDatabaseName(localAccountId, targetId)),
  ]
}

export interface RuntimeTargetDatabaseDeletionIo {
  deleteDatabase(name: string): Promise<void>
  databaseExists(name: string): Promise<boolean>
}

/**
 * Delete every database of a runtime target ({@link runtimeTargetDatabaseNames})
 * and verify each one is gone, so a delete that silently did nothing is an
 * error rather than a target reported removed while its data survives.
 * Returns the names deleted, in order. `label` prefixes the verification error.
 */
export async function deleteRuntimeTargetDatabases(
  localAccountId: string,
  targetId: string,
  io: RuntimeTargetDatabaseDeletionIo,
  label = "Runtime target database"
): Promise<string[]> {
  const deleted: string[] = []
  for (const databaseName of runtimeTargetDatabaseNames(localAccountId, targetId)) {
    await io.deleteDatabase(databaseName)
    if (await io.databaseExists(databaseName)) {
      throw new Error(`${label} deletion could not be verified: ${databaseName}`)
    }
    deleted.push(databaseName)
  }
  return deleted
}

function assertTargetId(targetId: string): string {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw new Error(
      "Runtime target id must be 3-128 characters and contain only letters, numbers, underscores, or hyphens."
    )
  }
  return targetId
}

function normalizeLabel(label: string): string {
  const normalized = label.trim()
  if (!normalized) throw new Error("Runtime target label is required.")
  return normalized
}

function validateTargetShape(
  kind: RuntimeTargetRecord["kind"],
  hostKind: RuntimeTargetRecord["hostKind"]
): void {
  if (kind === "companion" && !hostKind) {
    throw new Error("Companion runtime targets require a host kind.")
  }
  if (kind !== "companion" && hostKind) {
    throw new Error("Only Companion runtime targets may declare a host kind.")
  }
}

/**
 * The transport rule for a Companion target's base URL.
 *
 * Plaintext **loopback** is accepted unconditionally, because it is not a
 * downgrade — it is the only address a browser tab can reach the Host on. The
 * HTTPS listener presents a self-signed certificate with no CA and a tab
 * validates against system roots with no escape hatch, while
 * `http://127.0.0.1` is "potentially trustworthy" per Secure Contexts. Every
 * other guard on this same transport already says so: the pair screen's
 * `diagnoseTransport`, the Host's `web_origin::is_secure_or_loopback`, and both
 * MCP origin checks.
 *
 * This one used to demand `https:` and offer only a dev env flag, which made
 * the documented browser-plane topology impossible to pair without it — and it
 * runs AFTER the Host has consumed the one-shot invitation, so every attempt
 * burned a code and reported "require HTTPS" from a step the user could not
 * see. Loopback is now decided on the address, and the flag keeps its original
 * job: plaintext aimed OFF this machine, in development only.
 */
function normalizeHttpsUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol === "https:") return url.origin
  if (url.protocol === "http:") {
    if (isLoopbackHostname(url.hostname)) return url.origin
    const allowInsecureDevelopmentHttp =
      process.env.NODE_ENV !== "production" &&
      process.env.NEXT_PUBLIC_ALLOW_INSECURE_COMPANION_HTTP === "1"
    if (allowInsecureDevelopmentHttp) return url.origin
  }
  throw new Error("Companion runtime targets require HTTPS outside loopback.")
}
