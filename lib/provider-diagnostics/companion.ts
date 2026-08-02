import type {
  ProviderBalanceSnapshot,
  ProviderBalanceSource,
  ProviderDiagnosticCapability,
  ProviderDiagnosticJob,
  ProviderDiagnosticMode,
  ProviderDiagnosticSample,
} from "@cognia/provider-types"
import { getProviderConfig } from "@cognia/provider-types/provider"

import { getPairedDevice } from "@/lib/db/paired-devices"
import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { listBalanceAdapterEntries } from "@/lib/plugin/registries/balance-adapter-registry"
import { BALANCE_ADAPTERS } from "@/lib/subscription/balance/registry"
import { useAccountStore } from "@/stores/account/account-store"

import { cancelProviderDiagnosticJob, startProviderDiagnosticJob } from "./service"
import { resolveProviderDiagnosticTargets } from "./targets"

const MAX_REMOTE_HISTORY_ROWS = 200
const MAX_REMOTE_TARGETS = 20

interface RemoteTargetSelection {
  providerId: string
  modelId?: string
  capability: ProviderDiagnosticCapability
}

interface RemoteStartPayload {
  callerDeviceId?: unknown
  targets?: unknown
  mode?: unknown
  costConfirmed?: unknown
  confirmedRequestLimit?: unknown
  confirmedMaxEstimatedCostUsd?: unknown
}

function assertExactKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(payload).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new Error(
      `provider diagnostics payload contains forbidden fields: ${unexpected.join(", ")}`
    )
  }
}

function requiredDeviceId(payload: Record<string, unknown>): string {
  const value = payload.callerDeviceId
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("provider diagnostics callerDeviceId is required")
  }
  return value
}

async function assertRemoteControlDevice(deviceId: string): Promise<void> {
  const device = await getPairedDevice(deviceId)
  if (
    !device ||
    device.revokedAt !== undefined ||
    device.pausedAt !== undefined ||
    device.allowRemoteControl !== true
  ) {
    throw new Error("paired device is not permitted to run provider diagnostics")
  }
}

function parseTargets(value: unknown): RemoteTargetSelection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REMOTE_TARGETS) {
    throw new Error(`targets must contain between 1 and ${MAX_REMOTE_TARGETS} entries`)
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`targets[${index}] must be an object`)
    }
    const target = entry as Record<string, unknown>
    assertExactKeys(target, ["providerId", "modelId", "capability"])
    const providerId = target.providerId
    const modelId = target.modelId
    const capability = target.capability
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw new Error(`targets[${index}].providerId is required`)
    }
    if (modelId !== undefined && (typeof modelId !== "string" || modelId.length === 0)) {
      throw new Error(`targets[${index}].modelId must be a non-empty string`)
    }
    if (capability !== "probe" && capability !== "text-generation" && capability !== "embedding") {
      throw new Error(`targets[${index}].capability is invalid`)
    }
    return { providerId, modelId: modelId as string | undefined, capability }
  })
}

function sanitizeSample(
  sample: ProviderDiagnosticSample
): Omit<ProviderDiagnosticSample, "endpoint"> {
  const { endpoint: _endpoint, ...sanitized } = sample
  return sanitized
}

function sanitizeBalanceSnapshot(snapshot: ProviderBalanceSnapshot): ProviderBalanceSnapshot {
  return {
    id: snapshot.id,
    providerId: snapshot.providerId,
    sourceId: snapshot.sourceId,
    accountId: snapshot.accountId,
    credentialFingerprint: snapshot.credentialFingerprint,
    amounts: snapshot.amounts.map((amount) => ({ ...amount })),
    available: snapshot.available,
    fetchedAt: snapshot.fetchedAt,
    staleAt: snapshot.staleAt,
    failure: snapshot.failure,
  }
}

function balanceSourceProjection(
  snapshot: ProviderBalanceSnapshot,
  settings: Awaited<ReturnType<typeof getSettings>>
): ProviderBalanceSource {
  const script = settings.providerDiagnostics?.balanceScriptSources.find(
    (source) => source.id === snapshot.sourceId
  )
  const adapterKey = snapshot.sourceId.split(":").at(-1)
  const kind: ProviderBalanceSource["kind"] = script
    ? "sandbox-script"
    : snapshot.sourceId.includes(":legacy-")
      ? "official"
      : adapterKey === "unsupported"
        ? "unsupported"
        : BALANCE_ADAPTERS.some((adapter) => adapter.key === adapterKey)
          ? "official"
          : listBalanceAdapterEntries().some(({ entry }) => entry.key === adapterKey)
            ? "plugin"
            : "declarative"
  return {
    id: snapshot.sourceId,
    providerId: snapshot.providerId,
    accountId: snapshot.accountId,
    kind,
    label: script?.label ?? adapterKey ?? snapshot.sourceId,
    primary:
      settings.providerDiagnostics?.primaryBalanceSourceByProvider[snapshot.providerId] ===
      snapshot.sourceId,
    enabled: script?.enabled ?? true,
    unit: snapshot.amounts[0]?.unit,
  }
}

export async function getRemoteProviderDiagnosticsStatus(
  payload: Record<string, unknown>
): Promise<unknown> {
  assertExactKeys(payload, ["callerDeviceId", "providerId"])
  await assertRemoteControlDevice(requiredDeviceId(payload))
  const settings = await getSettings()
  const providerId = typeof payload.providerId === "string" ? payload.providerId : undefined
  const db = getDb()
  const jobs = providerId
    ? await db.providerDiagnosticJobs.where("providerId").equals(providerId).toArray()
    : await db.providerDiagnosticJobs.toArray()
  jobs.sort((left, right) => right.startedAt - left.startedAt)
  const latestByProvider = new Map<string, ProviderDiagnosticJob>()
  for (const job of jobs)
    if (!latestByProvider.has(job.providerId)) latestByProvider.set(job.providerId, job)
  const balanceRows = providerId
    ? await db.providerBalanceSnapshots.where("providerId").equals(providerId).toArray()
    : await db.providerBalanceSnapshots.toArray()
  balanceRows.sort((left, right) => right.fetchedAt - left.fetchedAt)
  const latestBalanceBySource = new Map<string, ProviderBalanceSnapshot>()
  for (const snapshot of balanceRows) {
    const key = `${snapshot.providerId}:${snapshot.sourceId}:${snapshot.accountId ?? "default"}`
    if (!latestBalanceBySource.has(key)) latestBalanceBySource.set(key, snapshot)
  }
  const projectedBalanceSources = [...latestBalanceBySource.values()].map((snapshot) =>
    balanceSourceProjection(snapshot, settings)
  )
  if (!projectedBalanceSources.some((source) => source.primary)) {
    const defaultPrimary =
      projectedBalanceSources.find((source) => source.kind === "official") ??
      projectedBalanceSources.find((source) => source.enabled)
    if (defaultPrimary) defaultPrimary.primary = true
  }
  return {
    capturedAt: Date.now(),
    desktopRevision: Math.max(0, ...jobs.map((job) => job.completedAt ?? job.startedAt)),
    stale: false,
    jobs: [...latestByProvider.values()].map(({ remoteAudit: _audit, ...job }) => job),
    balanceSnapshots: [...latestBalanceBySource.values()].map(sanitizeBalanceSnapshot),
    balanceSources: projectedBalanceSources,
  }
}

export async function getRemoteProviderDiagnosticsHistory(
  payload: Record<string, unknown>
): Promise<unknown> {
  assertExactKeys(payload, ["callerDeviceId", "providerId", "limit"])
  await assertRemoteControlDevice(requiredDeviceId(payload))
  const providerId = typeof payload.providerId === "string" ? payload.providerId : undefined
  const requestedLimit = typeof payload.limit === "number" ? Math.floor(payload.limit) : 50
  const limit = Math.max(1, Math.min(MAX_REMOTE_HISTORY_ROWS, requestedLimit))
  const rows = providerId
    ? await getDb().providerDiagnosticSamples.where("providerId").equals(providerId).toArray()
    : await getDb().providerDiagnosticSamples.toArray()
  rows.sort((left, right) => right.startedAt - left.startedAt)
  return {
    capturedAt: Date.now(),
    desktopRevision: rows[0]?.completedAt ?? rows[0]?.startedAt ?? 0,
    stale: false,
    samples: rows.slice(0, limit).map(sanitizeSample),
  }
}

export async function startRemoteProviderDiagnostics(
  payload: Record<string, unknown>
): Promise<{ accepted: true; jobId: string }> {
  assertExactKeys(payload, [
    "callerDeviceId",
    "targets",
    "mode",
    "costConfirmed",
    "confirmedRequestLimit",
    "confirmedMaxEstimatedCostUsd",
  ])
  const input = payload as RemoteStartPayload
  const deviceId = requiredDeviceId(payload)
  await assertRemoteControlDevice(deviceId)
  const accountState = useAccountStore.getState()
  if (!accountState.loaded || accountState.locked) throw new Error("credential vault is locked")

  const settings = await getSettings()
  const selections = parseTargets(input.targets)
  const providerId = selections[0].providerId
  const capability = selections[0].capability
  if (
    selections.some(
      (target) => target.providerId !== providerId || target.capability !== capability
    )
  ) {
    throw new Error("a remote diagnostic job must use one provider and one capability")
  }
  const mode: ProviderDiagnosticMode = input.mode === "precise" ? "precise" : "quick"
  const paid = capability !== "probe"
  if (paid && settings.providerDiagnostics?.remotePaidDiagnosticsEnabled !== true) {
    throw new Error("remote paid provider diagnostics are disabled on the desktop")
  }
  if (paid && input.costConfirmed !== true) {
    throw new Error("remote paid provider diagnostics require explicit cost confirmation")
  }
  if (paid) {
    const configured = settings.providerSettings?.[providerId]
    const custom = settings.customProviders?.find((provider) => provider.id === providerId)
    const allowedModels = new Set([
      ...(getProviderConfig(providerId)?.models.map((model) => model.id) ?? []),
      ...(configured?.enabledModels ?? []),
      ...(configured?.discoveredModels?.map((model) => model.id) ?? []),
      ...(custom?.customModels ?? []),
      ...(configured?.defaultModel ? [configured.defaultModel] : []),
      ...(custom?.defaultModel ? [custom.defaultModel] : []),
    ])
    if (selections.some((target) => !target.modelId || !allowedModels.has(target.modelId))) {
      throw new Error("remote diagnostics may only use models configured on the desktop")
    }
  }
  const preferences = settings.providerDiagnostics
  const confirmedRequestLimit = input.confirmedRequestLimit
  const confirmedMaxCost = input.confirmedMaxEstimatedCostUsd
  if (
    !Number.isFinite(confirmedRequestLimit) ||
    !Number.isFinite(confirmedMaxCost) ||
    (confirmedRequestLimit as number) <= 0 ||
    (confirmedMaxCost as number) < 0 ||
    (confirmedRequestLimit as number) > (preferences?.maxRequestsPerJob ?? 50) ||
    (confirmedMaxCost as number) > (preferences?.maxEstimatedCostUsd ?? 0.25)
  ) {
    throw new Error("confirmed diagnostic limits are missing or exceed desktop policy")
  }

  const resolved = await resolveProviderDiagnosticTargets({
    providerId,
    modelIds: selections.flatMap((target) => (target.modelId ? [target.modelId] : [])),
    capability,
    appSettings: settings,
  })
  const jobId = `provider-diagnostic-remote-${crypto.randomUUID()}`
  const requestedAt = Date.now()
  await getDb().providerDiagnosticJobs.put({
    id: jobId,
    providerId,
    mode,
    capability,
    status: "queued",
    targetCount: resolved.length,
    completedCount: 0,
    requestLimit: confirmedRequestLimit as number,
    maxEstimatedCostUsd: confirmedMaxCost as number,
    startedAt: requestedAt,
    remoteAudit: {
      deviceId,
      requestedAt,
      confirmedRequestLimit: confirmedRequestLimit as number,
      confirmedMaxEstimatedCostUsd: confirmedMaxCost as number,
    },
  })
  void startProviderDiagnosticJob({
    jobId,
    providerId,
    mode,
    capability,
    targets: resolved,
    unknownCostConfirmed: input.costConfirmed === true,
    preferences: {
      ...preferences,
      maxRequestsPerJob: confirmedRequestLimit as number,
      maxEstimatedCostUsd: confirmedMaxCost as number,
    },
    remoteAudit: {
      deviceId,
      requestedAt,
      confirmedRequestLimit: confirmedRequestLimit as number,
      confirmedMaxEstimatedCostUsd: confirmedMaxCost as number,
    },
  }).catch(async (error: unknown) => {
    const now = Date.now()
    await getDb().providerDiagnosticJobs.put({
      id: jobId,
      providerId,
      mode,
      capability,
      status: "failed",
      targetCount: resolved.length,
      completedCount: 0,
      requestLimit: confirmedRequestLimit as number,
      maxEstimatedCostUsd: confirmedMaxCost as number,
      startedAt: requestedAt,
      completedAt: now,
      remoteAudit: {
        deviceId,
        requestedAt,
        confirmedRequestLimit: confirmedRequestLimit as number,
        confirmedMaxEstimatedCostUsd: confirmedMaxCost as number,
        outcome: "failed",
      },
    })
    void error
  })
  return { accepted: true, jobId }
}

export async function cancelRemoteProviderDiagnostics(
  payload: Record<string, unknown>
): Promise<{ cancelled: boolean }> {
  assertExactKeys(payload, ["callerDeviceId", "jobId"])
  const deviceId = requiredDeviceId(payload)
  await assertRemoteControlDevice(deviceId)
  const jobId = typeof payload.jobId === "string" ? payload.jobId : ""
  if (!jobId) throw new Error("provider diagnostics jobId is required")
  const job = await getDb().providerDiagnosticJobs.get(jobId)
  if (!job || job.remoteAudit?.deviceId !== deviceId) {
    throw new Error("remote device may only cancel its own diagnostic jobs")
  }
  return { cancelled: cancelProviderDiagnosticJob(jobId) }
}
