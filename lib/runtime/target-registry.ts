import Dexie, { type Table } from "dexie"

import { assertAccountId } from "@/lib/accounts/account-types"
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

  async listTargets(accountId: string): Promise<RuntimeTargetRecord[]> {
    assertAccountId(accountId)
    return this.db.targets.where("accountId").equals(accountId).sortBy("lastUsedAt")
  }

  async getActiveTarget(accountId: string): Promise<RuntimeTargetRecord | null> {
    assertAccountId(accountId)
    const pointer = await this.db.activeTargets.get(accountId)
    if (!pointer) return null
    return (await this.db.targets.get([accountId, pointer.targetId])) ?? null
  }

  async ensureStandaloneTarget(accountId: string, now = Date.now()): Promise<RuntimeTargetRecord> {
    assertAccountId(accountId)
    const existing = await this.db.targets.get([accountId, DEFAULT_STANDALONE_TARGET_ID])
    if (existing) return existing
    return this.addTarget({
      accountId,
      id: DEFAULT_STANDALONE_TARGET_ID,
      kind: "standalone",
      label: "This browser",
      now,
    })
  }

  async addTarget(input: AddRuntimeTargetInput): Promise<RuntimeTargetRecord> {
    const accountId = assertAccountId(input.accountId)
    const id = assertTargetId(input.id)
    validateTargetShape(input.kind, input.hostKind)
    const now = input.now ?? Date.now()
    const row: RuntimeTargetRecord = {
      accountId,
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
    const accountId = assertAccountId(input.accountId)
    const id = assertTargetId(input.id)
    const now = input.now ?? Date.now()
    const existing = await this.db.targets.get([accountId, id])
    const row: RuntimeTargetRecord = {
      accountId,
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
    input: UpsertCompanionTargetInput
  ): Promise<RuntimeTargetRecord> {
    const accountId = assertAccountId(input.accountId)
    const id = assertTargetId(input.id)
    const now = input.now ?? Date.now()
    let activated: RuntimeTargetRecord | undefined
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const existing = await this.db.targets.get([accountId, id])
      activated = companionTargetRow(input, accountId, id, now, existing)
      await this.db.targets.put(activated)
      await this.db.activeTargets.put({ accountId, targetId: id, updatedAt: now })
    })
    return activated as RuntimeTargetRecord
  }

  async activateTarget(
    accountId: string,
    targetId: string,
    now = Date.now()
  ): Promise<RuntimeTargetRecord> {
    assertAccountId(accountId)
    assertTargetId(targetId)
    let activated: RuntimeTargetRecord | undefined
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const target = await this.db.targets.get([accountId, targetId])
      if (!target) {
        throw new Error(`Runtime target ${targetId} does not exist for account ${accountId}.`)
      }
      activated = { ...target, updatedAt: now, lastUsedAt: now }
      await this.db.targets.put(activated)
      await this.db.activeTargets.put({ accountId, targetId, updatedAt: now })
    })
    return activated as RuntimeTargetRecord
  }

  async ensureDefaultActiveTarget(
    accountId: string,
    now = Date.now()
  ): Promise<RuntimeTargetRecord> {
    const active = await this.getActiveTarget(accountId)
    if (active) return active
    const standalone = await this.ensureStandaloneTarget(accountId, now)
    return this.activateTarget(accountId, standalone.id, now)
  }

  async deleteTarget(accountId: string, targetId: string): Promise<void> {
    assertAccountId(accountId)
    assertTargetId(targetId)
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const active = await this.db.activeTargets.get(accountId)
      if (active?.targetId === targetId) {
        throw new Error("The active runtime target must be switched before it can be removed.")
      }
      await this.db.targets.delete([accountId, targetId])
    })
  }

  /**
   * Remove the sole active target and its pointer as one transaction.
   * Normal target removal must use `deleteTarget`; this escape hatch exists
   * for Mobile's verified sole-Host revocation, which transitions to unpaired.
   */
  async deleteActiveTarget(accountId: string, targetId: string): Promise<void> {
    assertAccountId(accountId)
    assertTargetId(targetId)
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      const active = await this.db.activeTargets.get(accountId)
      if (active?.targetId !== targetId) {
        throw new Error(`Runtime target ${targetId} is not the active runtime target.`)
      }
      await this.db.activeTargets.delete(accountId)
      await this.db.targets.delete([accountId, targetId])
    })
  }

  async deleteAccountTargets(accountId: string): Promise<void> {
    assertAccountId(accountId)
    await this.db.transaction("rw", this.db.targets, this.db.activeTargets, async () => {
      await this.db.targets.where("accountId").equals(accountId).delete()
      await this.db.activeTargets.delete(accountId)
    })
  }
}

function companionTargetRow(
  input: UpsertCompanionTargetInput,
  accountId: string,
  id: string,
  now: number,
  existing?: RuntimeTargetRecord
): RuntimeTargetRecord {
  return {
    accountId,
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

export function runtimeTargetDatabaseName(accountId: string, targetId: string): string {
  return `cognia-account-${assertAccountId(accountId)}-target-${assertTargetId(targetId)}`
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

function normalizeHttpsUrl(value: string): string {
  const url = new URL(value)
  const allowInsecureDevelopmentHttp =
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_ALLOW_INSECURE_COMPANION_HTTP === "1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowInsecureDevelopmentHttp)) {
    throw new Error("Companion runtime targets require HTTPS.")
  }
  return url.origin
}
