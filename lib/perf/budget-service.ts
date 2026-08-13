import {
  decryptAccountArtifactBytes,
  encryptAccountArtifactBytes,
} from "@/lib/ai/eval/artifact-crypto"
import {
  CogniaAccountRegistryDB,
  type EncryptedPerformanceBudgetProfileRow,
} from "@/lib/accounts/account-db"
import type { PerfRuntimeKind, PerfSourceKind } from "./backend/types"
import {
  assertPerformanceSecurityGeneration,
  getPerformanceSecurityGeneration,
} from "./security-generation"

export interface PerformanceBudgetProfile {
  id: string
  name: string
  version: number
  immutable: true
  metricId: string
  metricDefinitionVersion: number
  unit: string
  sourceKind: PerfSourceKind
  metricSchemaVersion: number
  requestedCadenceMs: number
  aggregation: "median" | "p95"
  direction: "lower" | "higher"
  warningThreshold: number
  failureThreshold: number
  applicability: {
    runtimeKinds: PerfRuntimeKind[]
    buildProfiles: Array<"production" | "profiling" | "development">
  }
  comparisonWindow: "interval"
  createdAt: number
}

export type CreatePerformanceBudgetProfileInput = Omit<
  PerformanceBudgetProfile,
  "id" | "immutable" | "createdAt"
> & {
  id?: string
  createdAt?: number
}

function aad(accountId: string, profileId: string, version: number): Uint8Array {
  return new TextEncoder().encode(
    ["cognia-performance-budget", "1", accountId, profileId, String(version)].join("\u001f")
  )
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function assertProfile(profile: PerformanceBudgetProfile): void {
  if (!profile.name.trim() || !profile.metricId.trim() || !profile.unit.trim()) {
    throw new Error("performance-budget-required-field-missing")
  }
  if (!Number.isSafeInteger(profile.version) || profile.version < 1) {
    throw new Error("performance-budget-version-invalid")
  }
  if (
    !Number.isSafeInteger(profile.metricDefinitionVersion) ||
    profile.metricDefinitionVersion < 1
  ) {
    throw new Error("performance-budget-metric-definition-invalid")
  }
  if (!Number.isSafeInteger(profile.metricSchemaVersion) || profile.metricSchemaVersion < 1) {
    throw new Error("performance-budget-schema-invalid")
  }
  if (!Number.isSafeInteger(profile.requestedCadenceMs) || profile.requestedCadenceMs < 500) {
    throw new Error("performance-budget-cadence-invalid")
  }
  if (!Number.isFinite(profile.warningThreshold) || !Number.isFinite(profile.failureThreshold)) {
    throw new Error("performance-budget-threshold-invalid")
  }
  const ordered =
    profile.direction === "lower"
      ? profile.warningThreshold <= profile.failureThreshold
      : profile.warningThreshold >= profile.failureThreshold
  if (!ordered) throw new Error("performance-budget-threshold-order-invalid")
}

export class PerformanceBudgetService {
  constructor(private readonly db = new CogniaAccountRegistryDB()) {}

  async create(
    accountId: string,
    key: Uint8Array,
    input: CreatePerformanceBudgetProfileInput
  ): Promise<PerformanceBudgetProfile> {
    const profile: PerformanceBudgetProfile = {
      ...input,
      id: input.id ?? `perf-budget-${crypto.randomUUID()}`,
      immutable: true,
      createdAt: input.createdAt ?? Date.now(),
      name: input.name.trim(),
      metricId: input.metricId.trim(),
      unit: input.unit.trim(),
      applicability: {
        runtimeKinds: [...input.applicability.runtimeKinds].sort(),
        buildProfiles: [...input.applicability.buildProfiles].sort(),
      },
    }
    assertProfile(profile)
    const generation = getPerformanceSecurityGeneration()
    const plain = new TextEncoder().encode(JSON.stringify(profile))
    const envelope = await encryptAccountArtifactBytes(
      key,
      plain,
      aad(accountId, profile.id, profile.version)
    )
    assertPerformanceSecurityGeneration(generation)
    const row: EncryptedPerformanceBudgetProfileRow = {
      id: profile.id,
      accountId,
      version: profile.version,
      metricIdHash: await sha256(profile.metricId),
      byteCount: envelope.iv.byteLength + envelope.ciphertext.byteLength,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      createdAt: profile.createdAt,
      updatedAt: profile.createdAt,
    }
    await this.db.transaction("rw", this.db.performanceBudgetProfiles, async () => {
      assertPerformanceSecurityGeneration(generation)
      if (await this.db.performanceBudgetProfiles.get(profile.id)) {
        throw new Error("performance-budget-immutable")
      }
      await this.db.performanceBudgetProfiles.add(row)
    })
    return profile
  }

  async list(accountId: string, key: Uint8Array): Promise<PerformanceBudgetProfile[]> {
    const generation = getPerformanceSecurityGeneration()
    const rows = await this.db.performanceBudgetProfiles
      .where("accountId")
      .equals(accountId)
      .toArray()
    const profiles = await Promise.all(
      rows.map((row) => this.decryptRow(accountId, key, row, generation))
    )
    assertPerformanceSecurityGeneration(generation)
    return profiles.sort((left, right) => right.createdAt - left.createdAt)
  }

  async get(
    accountId: string,
    key: Uint8Array,
    profileId: string
  ): Promise<PerformanceBudgetProfile | null> {
    const generation = getPerformanceSecurityGeneration()
    const row = await this.db.performanceBudgetProfiles.get(profileId)
    if (!row || row.accountId !== accountId) return null
    return this.decryptRow(accountId, key, row, generation)
  }

  close(): void {
    this.db.close()
  }

  private async decryptRow(
    accountId: string,
    key: Uint8Array,
    row: EncryptedPerformanceBudgetProfileRow,
    generation: number
  ): Promise<PerformanceBudgetProfile> {
    const plain = await decryptAccountArtifactBytes(
      key,
      {
        version: "cognia-account-artifact/v1",
        algorithm: "AES-GCM",
        iv: row.iv,
        ciphertext: row.ciphertext,
      },
      aad(accountId, row.id, row.version)
    )
    assertPerformanceSecurityGeneration(generation)
    const profile = JSON.parse(new TextDecoder().decode(plain)) as PerformanceBudgetProfile
    assertProfile(profile)
    if (profile.id !== row.id || profile.version !== row.version || !profile.immutable) {
      throw new Error("performance-budget-envelope-mismatch")
    }
    return profile
  }
}
