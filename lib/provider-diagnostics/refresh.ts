import { ensureMaintenanceSchedule } from "@/lib/scheduler/managed-tasks"
import type {
  ProviderDiagnosticFailureCode,
  ProviderDiagnosticsRefreshState,
} from "@cognia/provider-types"
import { getProviderConfig } from "@cognia/provider-types/provider"

import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { findBalanceAdapter } from "@/lib/subscription/balance/registry"
import { getTaskScheduler, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import { useAccountStore } from "@/stores/account/account-store"
import type { CreateScheduledTaskInput, ScheduledTaskType } from "@/types/scheduler"

import { refreshProviderBalanceSources, resolveProviderBalanceSource } from "./balance"
import { resolveSandboxBalanceSource } from "./balance"
import { runProviderProbe } from "./probe"
import { resolveProviderDiagnosticTargets } from "./targets"

export const PROVIDER_DIAGNOSTICS_REFRESH_TASK_TYPE =
  "provider-diagnostics-refresh" satisfies ScheduledTaskType

const PROBE_INTERVAL_MS = 15 * 60_000
const PRIMARY_BALANCE_INTERVAL_MS = 30 * 60_000
const OTHER_BALANCE_INTERVAL_MS = 2 * 60 * 60_000
const MAX_BACKOFF_MS = 24 * 60 * 60_000
const CLOCK_INTERVAL_MS = 5 * 60_000
const TASK_TAG = "system:provider-diagnostics"

type RefreshOutcome =
  | { kind: "success" }
  | { kind: "failure"; retryAfterMs?: number }
  | { kind: "authentication" }
  | { kind: "skipped" }

type ProviderDiagnosticsNotificationReason = NonNullable<
  ProviderDiagnosticsRefreshState["lastNotifiedReason"]
>

const NOTIFICATION_COOLDOWN_MS = 6 * 60 * 60_000

export function providerDiagnosticsNotificationTransition(input: {
  state: ProviderDiagnosticsRefreshState
  now: number
  failureCode?: ProviderDiagnosticFailureCode
  remaining?: number
  threshold?: number
}): ProviderDiagnosticsNotificationReason | undefined {
  if (
    input.state.lastNotificationAt !== undefined &&
    input.now - input.state.lastNotificationAt < NOTIFICATION_COOLDOWN_MS
  ) {
    return undefined
  }
  if (isAuthenticationFailure(input.failureCode) && input.state.status !== "paused-auth") {
    return "authentication"
  }
  if (input.failureCode && input.state.consecutiveFailures >= 2) return "repeated-failure"
  if (
    input.remaining !== undefined &&
    input.remaining <= 0 &&
    (input.state.lastObservedRemaining === undefined || input.state.lastObservedRemaining > 0)
  ) {
    return "zero-balance"
  }
  if (
    input.threshold !== undefined &&
    input.remaining !== undefined &&
    input.remaining <= input.threshold &&
    (input.state.lastObservedRemaining === undefined ||
      input.state.lastObservedRemaining > input.threshold)
  ) {
    return "low-balance"
  }
  return undefined
}

export function nextProviderDiagnosticsRefreshState(
  state: ProviderDiagnosticsRefreshState,
  outcome: {
    kind: RefreshOutcome["kind"]
    now: number
    intervalMs: number
    retryAfterMs?: number
  }
): ProviderDiagnosticsRefreshState {
  if (outcome.kind === "skipped") {
    return {
      ...state,
      status: "scheduled",
      nextDueAt: outcome.now + outcome.intervalMs,
      lastAttemptAt: outcome.now,
      lastOutcome: "skipped",
    }
  }
  if (outcome.kind === "success") {
    return {
      ...state,
      status: "scheduled",
      nextDueAt: outcome.now + outcome.intervalMs,
      lastAttemptAt: outcome.now,
      lastSuccessAt: outcome.now,
      lastOutcome: "succeeded",
      consecutiveFailures: 0,
      retryAfterMs: undefined,
    }
  }
  if (outcome.kind === "authentication") {
    return {
      ...state,
      status: "paused-auth",
      lastOutcome: "blocked",
      nextDueAt: Number.MAX_SAFE_INTEGER,
      lastAttemptAt: outcome.now,
      consecutiveFailures: state.consecutiveFailures + 1,
      retryAfterMs: undefined,
    }
  }
  const failures = state.consecutiveFailures + 1
  const exponential = Math.min(MAX_BACKOFF_MS, outcome.intervalMs * 2 ** Math.min(20, failures - 1))
  const delay = Math.min(MAX_BACKOFF_MS, Math.max(exponential, outcome.retryAfterMs ?? 0))
  return {
    ...state,
    status: "scheduled",
    lastOutcome: "failed",
    nextDueAt: outcome.now + delay,
    lastAttemptAt: outcome.now,
    consecutiveFailures: failures,
    retryAfterMs: outcome.retryAfterMs,
  }
}

function intervalForSource(sourceId: string): number {
  if (sourceId.startsWith("provider-reachability:")) return PROBE_INTERVAL_MS
  if (sourceId.endsWith(":primary")) return PRIMARY_BALANCE_INTERVAL_MS
  return OTHER_BALANCE_INTERVAL_MS
}

function isAuthenticationFailure(code?: ProviderDiagnosticFailureCode): boolean {
  return code === "authentication" || code === "permission"
}

async function defaultRunFreeSource(state: ProviderDiagnosticsRefreshState): Promise<{
  code?: ProviderDiagnosticFailureCode
  retryAfterMs?: number
  remaining?: number
  balanceSourceId?: string
}> {
  const settings = await getSettings()
  const configured = settings.providerSettings?.[state.providerId]
  const scriptConfig = settings.providerDiagnostics?.balanceScriptSources.find(
    (source) => state.sourceId === source.id || state.sourceId === `${source.id}:primary`
  )
  if (scriptConfig) {
    const [snapshot] = await refreshProviderBalanceSources([
      resolveSandboxBalanceSource(scriptConfig),
    ])
    return {
      code: snapshot ? snapshot.failure?.code : "invalid-response",
      retryAfterMs: snapshot?.failure?.retryAfterMs,
      remaining: snapshot?.amounts[0]?.remaining,
      balanceSourceId: scriptConfig.id,
    }
  }
  if (!configured?.enabled) return { code: "capability-unsupported" }
  if (state.sourceId.startsWith("provider-reachability:")) {
    const [target] = await resolveProviderDiagnosticTargets({
      providerId: state.providerId,
      modelIds: [],
      capability: "probe",
      appSettings: settings,
    })
    if (!target) return { code: "capability-unsupported" }
    const result = await runProviderProbe({
      providerId: state.providerId,
      protocol: target.credentials.protocol ?? "openai",
      baseURL: target.endpoint,
      apiKey: target.credentials.apiKey,
      headers: target.credentials.headers,
      model: target.modelId,
      bedrock: {
        authMode: target.credentials.bedrockAuthMode,
        region: target.credentials.region,
        accessKeyId: target.credentials.accessKeyId,
        secretAccessKey: target.credentials.secretAccessKey,
        sessionToken: target.credentials.sessionToken,
        profile: target.credentials.profile,
        roleArn: target.credentials.roleArn,
        roleSessionName: target.credentials.roleSessionName,
      },
    })
    return { code: result.failure?.code, retryAfterMs: result.failure?.retryAfterMs }
  }

  const config = getProviderConfig(state.providerId)
  const baseUrl = configured.baseURL ?? config?.defaultBaseURL
  if (!baseUrl || !configured.apiKey) return { code: "authentication" }
  const source = resolveProviderBalanceSource({
    providerId: state.providerId,
    providerKey: state.providerId,
    baseUrl,
    token: configured.apiKey,
    credentialId: "primary",
    label: state.providerId,
    primary: true,
  })
  const [snapshot] = await refreshProviderBalanceSources([source])
  return {
    code: snapshot ? snapshot.failure?.code : "invalid-response",
    retryAfterMs: snapshot?.failure?.retryAfterMs,
    remaining: snapshot?.amounts[0]?.remaining,
    balanceSourceId: source.id,
  }
}

interface RefreshClockDependencies {
  now: () => number
  isOnline: () => boolean
  isVaultAvailable: () => boolean
  listDueStates: (now: number) => Promise<ProviderDiagnosticsRefreshState[]>
  putState: (state: ProviderDiagnosticsRefreshState) => Promise<unknown>
  runFreeSource: typeof defaultRunFreeSource
  getThreshold: (sourceId?: string) => Promise<number | undefined>
  notifyTransition?: (
    reason: ProviderDiagnosticsNotificationReason,
    state: ProviderDiagnosticsRefreshState
  ) => Promise<void>
}

const DEFAULT_CLOCK_DEPENDENCIES: RefreshClockDependencies = {
  now: Date.now,
  isOnline: () => typeof navigator === "undefined" || navigator.onLine,
  isVaultAvailable: () => !useAccountStore.getState().locked,
  listDueStates: async (now) =>
    (
      await getDb().providerDiagnosticsRefreshState.where("nextDueAt").belowOrEqual(now).toArray()
    ).filter((state) => state.status !== "paused-auth"),
  putState: (state) => getDb().providerDiagnosticsRefreshState.put(state),
  runFreeSource: defaultRunFreeSource,
  getThreshold: async (sourceId) => {
    if (!sourceId) return undefined
    return (await getSettings()).providerDiagnostics?.lowBalanceThresholdsBySource[sourceId]?.value
  },
}

export async function runProviderDiagnosticsRefreshClock(
  dependencies: Partial<RefreshClockDependencies> = {}
): Promise<{
  scanned: number
  refreshed: number
  paused: number
  attempted: number
  succeeded: number
  failed: number
  blocked: number
  skipped: number
}> {
  const deps = { ...DEFAULT_CLOCK_DEPENDENCIES, ...dependencies }
  const currentTime = deps.now()
  const states = await deps.listDueStates(currentTime)
  if (!deps.isOnline() || !deps.isVaultAvailable()) {
    const status = deps.isOnline() ? "paused-vault" : "paused-offline"
    await Promise.all(
      states.map((state) =>
        deps.putState({
          ...state,
          status,
          nextDueAt: currentTime + 60_000,
        })
      )
    )
    return {
      scanned: states.length,
      refreshed: 0,
      paused: states.length,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      blocked: states.length,
      skipped: 0,
    }
  }

  let succeeded = 0
  let failed = 0
  let blocked = 0
  let skipped = 0
  for (const state of states) {
    await deps.putState({ ...state, status: "running", lastAttemptAt: currentTime })
    try {
      const failure = await deps.runFreeSource(state)
      const outcome: RefreshOutcome = isAuthenticationFailure(failure.code)
        ? { kind: "authentication" }
        : failure.code === "capability-unsupported"
          ? { kind: "skipped" }
          : failure.code
            ? { kind: "failure", retryAfterMs: failure.retryAfterMs }
            : { kind: "success" }
      const next = nextProviderDiagnosticsRefreshState(state, {
        ...outcome,
        now: currentTime,
        intervalMs: intervalForSource(state.sourceId),
      })
      const threshold = await deps.getThreshold(failure.balanceSourceId).catch(() => undefined)
      const notificationReason = providerDiagnosticsNotificationTransition({
        state,
        now: currentTime,
        failureCode: failure.code,
        remaining: failure.remaining,
        threshold,
      })
      const observed = {
        ...next,
        ...(failure.remaining !== undefined ? { lastObservedRemaining: failure.remaining } : {}),
        ...(notificationReason && deps.notifyTransition
          ? { lastNotificationAt: currentTime, lastNotifiedReason: notificationReason }
          : {}),
      }
      await deps.putState(observed)
      if (outcome.kind === "success") succeeded++
      else if (outcome.kind === "authentication") blocked++
      else if (outcome.kind === "skipped") skipped++
      else failed++
      // Periodic diagnostics retain transitions for inspection, without an OS
      // notification. An explicitly supplied observer may opt into delivery.
      if (notificationReason)
        await deps.notifyTransition?.(notificationReason, observed).catch(() => undefined)
    } catch {
      failed++
      await deps.putState(
        nextProviderDiagnosticsRefreshState(state, {
          kind: "failure",
          now: currentTime,
          intervalMs: intervalForSource(state.sourceId),
        })
      )
    }
  }
  return {
    scanned: states.length,
    refreshed: succeeded,
    paused: blocked,
    attempted: states.length,
    succeeded,
    failed,
    blocked,
    skipped,
  }
}

export async function ensureProviderDiagnosticsRefreshStates(): Promise<void> {
  const settings = await getSettings()
  const now = Date.now()
  const states: ProviderDiagnosticsRefreshState[] = []
  for (const [providerId, configured] of Object.entries(settings.providerSettings ?? {})) {
    if (!configured.enabled) continue
    states.push({
      sourceId: `provider-reachability:${providerId}`,
      providerId,
      status: "scheduled",
      nextDueAt: now,
      consecutiveFailures: 0,
    })
    const config = getProviderConfig(providerId)
    const baseUrl = configured.baseURL ?? config?.defaultBaseURL
    if (baseUrl && configured.apiKey && findBalanceAdapter({ providerKey: providerId, baseUrl })) {
      states.push({
        sourceId: `provider-balance:${providerId}:primary`,
        providerId,
        status: "scheduled",
        nextDueAt: now,
        consecutiveFailures: 0,
      })
    }
  }
  for (const source of settings.providerDiagnostics?.balanceScriptSources ?? []) {
    if (!source.enabled) continue
    const primary =
      settings.providerDiagnostics?.primaryBalanceSourceByProvider[source.providerId] === source.id
    states.push({
      sourceId: `${source.id}${primary ? ":primary" : ""}`,
      providerId: source.providerId,
      status: "scheduled",
      nextDueAt: now,
      consecutiveFailures: 0,
    })
  }
  if (states.length === 0) return
  const db = getDb()
  const table = db.providerDiagnosticsRefreshState
  // Seed only missing sources, atomically. Boot must not undo auth pauses,
  // server Retry-After, failure backoff, or notification cooldown state.
  await db.transaction("rw", table, async () => {
    const existing = await table.bulkGet(states.map((state) => state.sourceId))
    const missing = states.filter((_, index) => !existing[index])
    if (missing.length > 0) await table.bulkAdd(missing)
  })
}

/** A successful user-requested probe is explicit evidence to resume its paused clock. */
export async function resumeProviderReachabilityRefresh(providerId: string): Promise<void> {
  const db = getDb()
  const table = db.providerDiagnosticsRefreshState
  await db.transaction("rw", table, async () => {
    const sourceId = `provider-reachability:${providerId}`
    const existing = await table.get(sourceId)
    if (existing?.status !== "paused-auth") return
    await table.update(sourceId, {
      status: "scheduled",
      nextDueAt: Date.now() + PROBE_INTERVAL_MS,
      consecutiveFailures: 0,
      retryAfterMs: undefined,
    })
  })
}

/** Resume only the exact balance credential/script successfully checked by the user. */
export async function resumeProviderBalanceRefresh(
  source: import("./balance").ResolvedProviderBalanceSource
): Promise<void> {
  const candidates =
    source.kind === "sandbox-script"
      ? [source.id, `${source.id}:primary`]
      : source.credentialId === "primary" && !source.accountId
        ? [`provider-balance:${source.providerId}:primary`]
        : []
  const db = getDb()
  const table = db.providerDiagnosticsRefreshState
  await db.transaction("rw", table, async () => {
    for (const sourceId of candidates) {
      const state = await table.get(sourceId)
      if (state?.providerId !== source.providerId || state.status !== "paused-auth") continue
      const now = Date.now()
      await table.update(sourceId, {
        status: "scheduled",
        nextDueAt: now + intervalForSource(sourceId),
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastOutcome: "succeeded",
        consecutiveFailures: 0,
        retryAfterMs: undefined,
      })
    }
  })
}

/**
 * Register the scheduler executor for the refresh clock.
 *
 * Separate from {@link installProviderDiagnosticsRefreshSchedule} because the
 * persisted task outlives the boot that seeded it. A scheduler started by a
 * lifecycle write (plugin activation, another subsystem's schedule) never runs
 * that boot, so the scheduler loads this on demand through
 * `lib/scheduler/executor-owners.ts` when the task comes due.
 */
export function registerProviderDiagnosticsRefreshExecutor(): void {
  registerTaskExecutor(PROVIDER_DIAGNOSTICS_REFRESH_TASK_TYPE, async () => ({
    success: true,
    output: await runProviderDiagnosticsRefreshClock(),
  }))
}

export async function installProviderDiagnosticsRefreshSchedule(): Promise<void> {
  registerProviderDiagnosticsRefreshExecutor()
  const scheduler = getTaskScheduler()
  const task: CreateScheduledTaskInput = {
    name: "Provider diagnostics refresh",
    type: PROVIDER_DIAGNOSTICS_REFRESH_TASK_TYPE,
    trigger: { type: "interval", intervalMs: CLOCK_INTERVAL_MS },
    config: { runMissedOnStartup: true, catchupWindowMs: 24 * 60 * 60_000, maxMissedRuns: 1 },
    notification: {
      dueReminder: false,
      onStart: false,
      onComplete: false,
      onError: false,
      onProgress: false,
      channels: ["none"],
    },
    createdBy: { kind: "user" },
    tags: [TASK_TAG],
  }
  await ensureMaintenanceSchedule(scheduler, task)
  await ensureProviderDiagnosticsRefreshStates()
}
