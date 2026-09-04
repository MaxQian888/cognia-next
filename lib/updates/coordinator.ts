/**
 * The Update Center coordinator.
 *
 * One engine drives every asset kind: it registers adapters, de-duplicates
 * concurrent checks, applies backoff with jitter and `Retry-After`, projects
 * adapter results into rows the UI renders, persists a snapshot per asset, and
 * reconciles that snapshot on the next launch.
 *
 * Two rules it enforces that no adapter may override:
 *  1. A critical update can be deferred but never permanently skipped, and it
 *     never blocks normal use of the app.
 *  2. Background download is available to first-party desktop packages only.
 *     Anything that widens permissions, changes skill content, goes through a
 *     store, or updates the CLI requires explicit consent first.
 */

import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  EXECUTOR_PRIMARY_ACTION,
  canTransitionUpdateState,
  isInAppExecutor,
  updateSnapshotKey,
  type UpdateAssetKind,
  type UpdateCandidate,
  type UpdateCenterSettings,
  type UpdateChannel,
  type UpdateFailure,
  type UpdateSnapshot,
  type UpdateState,
} from "@cognia/agent-config-types"

import type { UpdateAdapter, UpdateApplyContext, UpdateItem } from "./adapter"
import { backoffDelayMs, isCheckDue } from "./backoff"
import type { CatalogEntry } from "./catalog-types"
import { normalizeRolloutBucket, rolloutVerdict } from "./rollout"
import {
  newAttemptId,
  sanitizeTelemetryEvent,
  type UpdateTelemetryEvent,
  type UpdateTelemetrySink,
} from "./telemetry"

/** Default gap between automatic sweeps. */
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How long "Remind me later" holds a routine update. */
export const DEFAULT_DEFER_MS = 24 * 60 * 60 * 1000

/** Critical updates come back sooner, because they are the ones that matter. */
export const CRITICAL_DEFER_MS = 4 * 60 * 60 * 1000

export interface UpdatePersistence {
  /** Current settings, read synchronously from an already-hydrated store. */
  read(): UpdateCenterSettings
  /** Persist a patch. Failures must not take the coordinator down. */
  write(patch: Partial<UpdateCenterSettings>): Promise<void>
}

export interface CatalogFetchResult {
  entries: readonly CatalogEntry[]
  /** Server-requested hold in milliseconds, if the response carried one. */
  retryAfterMs?: number
}

export interface CoordinatorDeps {
  adapters: readonly UpdateAdapter[]
  persistence: UpdatePersistence
  /** Resolve the verified catalog. Returning null means "unavailable". */
  fetchCatalog: (options: {
    channel: UpdateChannel
    signal?: AbortSignal
  }) => Promise<CatalogFetchResult | null>
  now?: () => number
  random?: () => number
  checkIntervalMs?: () => number
  telemetry?: UpdateTelemetrySink
  /** Running app version, used to verify a desktop attempt after restart. */
  appVersion?: string
  onError?: (scope: string, error: unknown) => void
}

export interface CheckOptions {
  manual?: boolean
  /** Restrict the sweep to one asset kind. */
  kind?: UpdateAssetKind
  signal?: AbortSignal
}

interface InternalRow extends UpdateItem {
  snapshot: UpdateSnapshot
}

function classify(error: unknown): UpdateFailure {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes("abort") || message.includes("cancel")) {
    return { kind: "cancelled", code: "aborted" }
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return { kind: "timeout", code: "request_timeout", recoveryActionKey: "retry" }
  }
  if (message.includes("signature") || message.includes("minisign") || message.includes("pubkey")) {
    return { kind: "signature", code: "bad_signature", recoveryActionKey: "contactSupport" }
  }
  if (message.includes("expired")) {
    return { kind: "expired", code: "metadata_expired", recoveryActionKey: "retryLater" }
  }
  if (message.includes("rollback")) {
    return { kind: "rollback", code: "rollback_refused", recoveryActionKey: "contactSupport" }
  }
  if (message.includes("revoked")) {
    return { kind: "revoked", code: "release_revoked", recoveryActionKey: "retryLater" }
  }
  if (
    message.includes("permission") ||
    message.includes("not allowed") ||
    message.includes("acl")
  ) {
    return { kind: "permission", code: "permission_denied", recoveryActionKey: "reviewPermissions" }
  }
  if (message.includes("space") || message.includes("disk") || message.includes("enospc")) {
    return { kind: "disk", code: "insufficient_space", recoveryActionKey: "freeSpace" }
  }
  if (message.includes("incompatible") || message.includes("unsupported version")) {
    return { kind: "incompatible", code: "incompatible", recoveryActionKey: "updateHost" }
  }
  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("dns") ||
    message.includes("offline") ||
    message.includes("connection")
  ) {
    return { kind: "network", code: "network_unreachable", recoveryActionKey: "retry" }
  }
  return { kind: "unknown", code: "unknown", recoveryActionKey: "retry" }
}

export class UpdateCoordinator {
  private readonly deps: Required<
    Pick<CoordinatorDeps, "adapters" | "persistence" | "fetchCatalog">
  > &
    CoordinatorDeps
  private readonly rows = new Map<string, InternalRow>()
  private readonly listeners = new Set<() => void>()
  private readonly applyInFlight = new Map<string, Promise<UpdateItem>>()
  private sweepInFlight: Promise<UpdateItem[]> | null = null
  private cachedView: UpdateItem[] = []
  private viewDirty = true
  private restored = false

  constructor(deps: CoordinatorDeps) {
    this.deps = deps as UpdateCoordinator["deps"]
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private random(): number {
    return (this.deps.random ?? Math.random)()
  }

  private intervalMs(): number {
    return this.deps.checkIntervalMs?.() ?? DEFAULT_CHECK_INTERVAL_MS
  }

  private settings(): UpdateCenterSettings {
    try {
      return { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...this.deps.persistence.read() }
    } catch {
      return { ...DEFAULT_UPDATE_CENTER_SETTINGS }
    }
  }

  private emit(): void {
    this.viewDirty = true
    for (const listener of this.listeners) listener()
  }

  private track(event: UpdateTelemetryEvent): void {
    try {
      this.deps.telemetry?.(sanitizeTelemetryEvent(event))
    } catch (error) {
      this.deps.onError?.("telemetry", error)
    }
  }

  private async persistSnapshot(row: InternalRow): Promise<void> {
    const settings = this.settings()
    const snapshots = { ...(settings.snapshots ?? {}), [row.key]: row.snapshot }
    try {
      await this.deps.persistence.write({ snapshots })
    } catch (error) {
      this.deps.onError?.("persist", error)
    }
  }

  /** Adapters that apply on this host. */
  supportedAdapters(): UpdateAdapter[] {
    return this.deps.adapters.filter((adapter) => {
      try {
        return adapter.isSupported()
      } catch {
        return false
      }
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stable, memoized snapshot for `useSyncExternalStore`. */
  getItems(): UpdateItem[] {
    if (this.viewDirty) {
      this.cachedView = [...this.rows.values()].map(({ snapshot: _snapshot, ...item }) => item)
      this.viewDirty = false
    }
    return this.cachedView
  }

  getItem(key: string): UpdateItem | undefined {
    return this.rows.get(key)
  }

  /** Rollout bucket for this device, generated and persisted on first use. */
  rolloutBucket(): number {
    const settings = this.settings()
    const normalized = normalizeRolloutBucket(settings.rolloutBucket, () => this.random())
    if (normalized !== settings.rolloutBucket) {
      void this.deps.persistence
        .write({ rolloutBucket: normalized })
        .catch((error) => this.deps.onError?.("persist", error))
    }
    return normalized
  }

  private ensureRow(
    kind: UpdateAssetKind,
    assetId: string,
    executor: UpdateItem["executor"]
  ): InternalRow {
    const key = updateSnapshotKey(kind, assetId)
    const existing = this.rows.get(key)
    if (existing) return existing
    const persisted = this.settings().snapshots?.[key]
    const snapshot: UpdateSnapshot = persisted ?? { assetId, kind, state: "current" }
    const row: InternalRow = {
      key,
      assetId,
      kind,
      executor,
      state: snapshot.state,
      candidate: null,
      currentVersion: null,
      action: null,
      externallyInstalled: !isInAppExecutor(executor),
      lastCheckedAt: snapshot.lastCheckedAt,
      skippedVersion: snapshot.skippedVersion,
      deferredUntil: snapshot.deferredUntil,
      failure: snapshot.failure,
      snapshot,
    }
    this.rows.set(key, row)
    return row
  }

  private setState(row: InternalRow, next: UpdateState, patch: Partial<InternalRow> = {}): void {
    if (!canTransitionUpdateState(row.state, next)) {
      this.deps.onError?.("transition", new Error(`illegal ${row.state} to ${next} for ${row.key}`))
      return
    }
    row.state = next
    row.snapshot = { ...row.snapshot, state: next }
    Object.assign(row, patch)
    this.emit()
  }

  /**
   * Reconcile persisted state at boot. A desktop attempt that was mid-install
   * when the process died is resolved here against the version actually
   * running, which is the only honest way to tell "installed" from "died".
   */
  async restore(): Promise<void> {
    if (this.restored) return
    this.restored = true
    const settings = this.settings()
    const snapshots = settings.snapshots ?? {}
    const patched: Record<string, UpdateSnapshot> = {}

    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (!snapshot || typeof snapshot !== "object") continue
      const adapter = this.deps.adapters.find((a) => a.kind === snapshot.kind)
      const row = this.ensureRow(snapshot.kind, snapshot.assetId, adapter?.executor ?? "tauri")
      row.snapshot = snapshot
      row.state = snapshot.state
      row.lastCheckedAt = snapshot.lastCheckedAt
      row.skippedVersion = snapshot.skippedVersion
      row.deferredUntil = snapshot.deferredUntil
      row.failure = snapshot.failure

      const unfinished =
        snapshot.state === "installing" ||
        snapshot.state === "downloading" ||
        snapshot.state === "awaiting-restart"
      if (!unfinished || snapshot.kind !== "desktop") continue

      const running = this.deps.appVersion
      if (running && snapshot.targetVersion && running === snapshot.targetVersion) {
        row.state = "verified"
        row.snapshot = { ...snapshot, state: "verified", attemptId: undefined, failure: undefined }
        this.track({
          attemptId: snapshot.attemptId ?? newAttemptId(),
          kind: snapshot.kind,
          executor: row.executor,
          channel: settings.channel,
          fromVersion: snapshot.fromVersion ?? null,
          toVersion: snapshot.targetVersion ?? null,
          phase: "verified",
          outcome: "succeeded",
          durationMs: snapshot.startedAt ? this.now() - snapshot.startedAt : undefined,
        })
      } else {
        const failure: UpdateFailure = {
          kind: "unknown",
          code: "install_interrupted",
          recoveryActionKey: "retryInstall",
        }
        row.state = "failed"
        row.failure = failure
        row.snapshot = { ...snapshot, state: "failed", failure }
        this.track({
          attemptId: snapshot.attemptId ?? newAttemptId(),
          kind: snapshot.kind,
          executor: row.executor,
          channel: settings.channel,
          fromVersion: snapshot.fromVersion ?? null,
          toVersion: snapshot.targetVersion ?? null,
          phase: "failed",
          outcome: "failed",
          errorKind: failure.kind,
          errorCode: failure.code,
        })
      }
      patched[key] = row.snapshot
    }

    if (Object.keys(patched).length > 0) {
      try {
        await this.deps.persistence.write({ snapshots: { ...snapshots, ...patched } })
      } catch (error) {
        this.deps.onError?.("persist", error)
      }
    }
    this.emit()
  }

  /**
   * Sweep every supported adapter. Concurrent callers share one sweep, so a
   * boot check and a user tapping Check cannot double-hit the endpoint.
   */
  check(options: CheckOptions = {}): Promise<UpdateItem[]> {
    if (this.sweepInFlight && !options.manual) return this.sweepInFlight
    if (this.sweepInFlight) return this.sweepInFlight
    const task = this.runCheck(options).finally(() => {
      this.sweepInFlight = null
    })
    this.sweepInFlight = task
    return task
  }

  private async runCheck(options: CheckOptions): Promise<UpdateItem[]> {
    await this.restore()
    const manual = options.manual ?? false
    const settings = this.settings()
    const bucket = this.rolloutBucket()
    const now = this.now()

    let catalog: readonly CatalogEntry[] | null = null
    let retryAfterMs: number | undefined
    try {
      const result = await this.deps.fetchCatalog({
        channel: settings.channel,
        signal: options.signal,
      })
      catalog = result?.entries ?? null
      retryAfterMs = result?.retryAfterMs
    } catch (error) {
      this.deps.onError?.("catalog", error)
      catalog = null
    }

    const adapters = this.supportedAdapters().filter(
      (a) => !options.kind || a.kind === options.kind
    )

    // Mark known rows as checking so the UI can show progress. New rows appear
    // only once the adapter answers, which is why this cannot be the only way
    // into `available`.
    for (const row of this.rows.values()) {
      if (options.kind && row.kind !== options.kind) continue
      if (row.state === "installing" || row.state === "downloading") continue
      this.setState(row, "checking")
    }

    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          const candidates = await adapter.check({
            channel: settings.channel,
            rolloutBucket: bucket,
            manual,
            catalog,
            signal: options.signal,
          })
          this.absorb(adapter, candidates, { manual, bucket, now, settings })
        } catch (error) {
          this.recordCheckFailure(adapter, error, { now, retryAfterMs })
        }
      })
    )

    await this.flushSnapshots()
    this.emit()
    return this.getItems()
  }

  private absorb(
    adapter: UpdateAdapter,
    candidates: readonly UpdateCandidate[],
    context: { manual: boolean; bucket: number; now: number; settings: UpdateCenterSettings }
  ): void {
    const { manual, bucket, now, settings } = context
    const seen = new Set<string>()

    for (const candidate of candidates) {
      const row = this.ensureRow(candidate.kind, candidate.assetId, candidate.executor)
      seen.add(row.key)
      row.currentVersion = candidate.currentVersion
      row.lastCheckedAt = now
      row.snapshot = {
        ...row.snapshot,
        lastCheckedAt: now,
        consecutiveFailures: 0,
        nextCheckAt: now + this.intervalMs(),
        failure: undefined,
      }
      row.failure = undefined

      if (candidate.provenance !== "verified" && candidate.source === "catalog") {
        const failure: UpdateFailure = {
          kind: candidate.provenance === "revoked" ? "revoked" : "signature",
          code: `provenance_${candidate.provenance}`,
          recoveryActionKey: "retryLater",
        }
        row.failure = failure
        row.snapshot = { ...row.snapshot, failure }
        this.setState(row, "failed", { candidate: null, action: null })
        continue
      }

      const verdict = rolloutVerdict(candidate.rollout, bucket, { manual })
      if (verdict !== "offered") {
        this.setState(row, "current", { candidate: null, action: null })
        continue
      }

      if (
        row.snapshot.skippedVersion === candidate.targetVersion &&
        candidate.criticality !== "critical"
      ) {
        this.setState(row, "current", { candidate: null, action: null })
        continue
      }

      const deferredActive =
        row.snapshot.deferredVersion === candidate.targetVersion &&
        (row.snapshot.deferredUntil ?? 0) > now
      if (deferredActive && !manual) {
        this.setState(row, "deferred", { candidate, action: null })
        continue
      }

      row.candidate = candidate
      row.action = candidate.action ?? EXECUTOR_PRIMARY_ACTION[candidate.executor]
      row.externalUrl = candidate.externalUrl
      row.externallyInstalled = !isInAppExecutor(candidate.executor)
      this.setState(row, "available", { candidate, action: row.action })

      const backgroundEligible =
        candidate.kind === "desktop" &&
        candidate.executor === "tauri" &&
        settings.backgroundDownloadDesktop &&
        !candidate.permissionsExpanded
      if (backgroundEligible) {
        void this.apply(row.key, { consented: true, downloadOnly: true }).catch((error) =>
          this.deps.onError?.("background-download", error)
        )
      }
    }

    // An asset the adapter no longer reports is current again.
    for (const row of this.rows.values()) {
      if (row.kind !== adapter.kind || seen.has(row.key)) continue
      if (row.state === "installing" || row.state === "downloading") continue
      row.candidate = null
      row.action = null
      row.lastCheckedAt = now
      row.snapshot = { ...row.snapshot, lastCheckedAt: now, consecutiveFailures: 0 }
      this.setState(row, "current")
    }
  }

  private recordCheckFailure(
    adapter: UpdateAdapter,
    error: unknown,
    context: { now: number; retryAfterMs?: number }
  ): void {
    const failure = classify(error)
    const rows = [...this.rows.values()].filter((row) => row.kind === adapter.kind)
    const targets =
      rows.length > 0 ? rows : [this.ensureRow(adapter.kind, adapter.kind, adapter.executor)]
    for (const row of targets) {
      const consecutiveFailures = (row.snapshot.consecutiveFailures ?? 0) + 1
      const delay = backoffDelayMs({
        consecutiveFailures,
        intervalMs: this.intervalMs(),
        retryAfterMs: context.retryAfterMs,
        random: () => this.random(),
      })
      row.failure = failure
      row.snapshot = {
        ...row.snapshot,
        consecutiveFailures,
        lastCheckedAt: context.now,
        nextCheckAt: context.now + delay,
        failure,
      }
      row.lastCheckedAt = context.now
      this.setState(row, "failed")
    }
    this.deps.onError?.(`check:${adapter.kind}`, error)
  }

  /** True when the automatic sweep is allowed to run right now. */
  isSweepDue(): boolean {
    const now = this.now()
    const rows = [...this.rows.values()]
    if (rows.length === 0) return true
    return rows.some((row) => isCheckDue(now, row.snapshot.nextCheckAt))
  }

  /**
   * Act on one row. `consented` is required for anything that is not a
   * first-party desktop package with unchanged permissions.
   */
  apply(
    key: string,
    options: UpdateApplyContext & { downloadOnly?: boolean } = { consented: false }
  ): Promise<UpdateItem> {
    const inFlight = this.applyInFlight.get(key)
    if (inFlight) return inFlight
    const task = this.runApply(key, options).finally(() => this.applyInFlight.delete(key))
    this.applyInFlight.set(key, task)
    return task
  }

  private async runApply(
    key: string,
    options: UpdateApplyContext & { downloadOnly?: boolean }
  ): Promise<UpdateItem> {
    const row = this.rows.get(key)
    if (!row) throw new Error(`unknown update row ${key}`)
    const candidate = row.candidate
    if (!candidate) return row

    const settings = this.settings()
    const requiresConsent =
      candidate.permissionsExpanded === true ||
      candidate.compatibility?.breaking === true ||
      candidate.kind === "skill" ||
      candidate.kind === "cli" ||
      candidate.action === "open-store" ||
      !isInAppExecutor(candidate.executor)

    if (requiresConsent && !options.consented) {
      this.setState(row, "awaiting-consent", {
        action: candidate.permissionsExpanded ? "review-permissions" : row.action,
      })
      return row
    }

    const adapter = this.deps.adapters.find(
      (a) => a.kind === candidate.kind && a.executor === candidate.executor
    )
    if (!adapter) {
      const failure: UpdateFailure = { kind: "unsupported", code: "no_adapter" }
      row.failure = failure
      row.snapshot = { ...row.snapshot, failure }
      this.setState(row, "failed")
      await this.persistSnapshot(row)
      return row
    }

    const attemptId = row.snapshot.attemptId ?? newAttemptId()
    const startedAt = this.now()
    row.snapshot = {
      ...row.snapshot,
      attemptId,
      fromVersion: candidate.currentVersion ?? undefined,
      targetVersion: candidate.targetVersion,
      startedAt,
    }
    const nextState: UpdateState = options.downloadOnly ? "downloading" : "installing"
    this.setState(row, nextState, { progress: undefined })
    // Written before any bytes move so a crash mid-install is recognisable.
    await this.persistSnapshot(row)

    this.track({
      attemptId,
      kind: candidate.kind,
      executor: candidate.executor,
      channel: settings.channel,
      fromVersion: candidate.currentVersion,
      toVersion: candidate.targetVersion,
      phase: nextState,
      outcome: "started",
    })

    try {
      let downloadedBytes: number | undefined
      const result = await adapter.apply(candidate, {
        consented: options.consented || !requiresConsent,
        signal: options.signal,
        onProgress: (downloaded, total) => {
          downloadedBytes = downloaded
          row.progress = { downloaded, total }
          options.onProgress?.(downloaded, total)
          this.emit()
        },
      })
      row.progress = undefined
      row.command = result.command
      row.externalUrl = result.externalUrl ?? row.externalUrl
      row.failure = result.failure
      row.snapshot = { ...row.snapshot, failure: result.failure }
      if (result.state === "verified" || result.state === "current") {
        row.candidate = null
        row.action = null
        row.currentVersion = candidate.targetVersion
        row.snapshot = { ...row.snapshot, attemptId: undefined }
      }
      this.setState(row, result.state)
      await this.persistSnapshot(row)
      this.track({
        attemptId,
        kind: candidate.kind,
        executor: candidate.executor,
        channel: settings.channel,
        fromVersion: candidate.currentVersion,
        toVersion: candidate.targetVersion,
        phase: result.state,
        durationMs: this.now() - startedAt,
        // Read from the local tally: `row.progress` is cleared above, so
        // reading it here would always report nothing transferred.
        bytes: downloadedBytes,
        outcome: result.failure
          ? "failed"
          : isInAppExecutor(candidate.executor)
            ? "succeeded"
            : "handed-off",
        errorKind: result.failure?.kind,
        errorCode: result.failure?.code,
      })
      return row
    } catch (error) {
      const failure = classify(error)
      row.progress = undefined
      row.failure = failure
      row.snapshot = { ...row.snapshot, failure }
      this.setState(row, failure.kind === "cancelled" ? "cancelled" : "failed")
      await this.persistSnapshot(row)
      this.track({
        attemptId,
        kind: candidate.kind,
        executor: candidate.executor,
        channel: settings.channel,
        fromVersion: candidate.currentVersion,
        toVersion: candidate.targetVersion,
        phase: "failed",
        durationMs: this.now() - startedAt,
        outcome: failure.kind === "cancelled" ? "cancelled" : "failed",
        errorKind: failure.kind,
        errorCode: failure.code,
      })
      return row
    }
  }

  /**
   * Never be told about this version again. Refused for critical updates,
   * which may only be deferred.
   */
  async skip(key: string): Promise<boolean> {
    const row = this.rows.get(key)
    if (!row?.candidate) return false
    if (row.candidate.criticality === "critical") return false
    row.snapshot = { ...row.snapshot, skippedVersion: row.candidate.targetVersion }
    row.skippedVersion = row.candidate.targetVersion
    row.candidate = null
    row.action = null
    this.setState(row, "current")
    await this.persistSnapshot(row)
    return true
  }

  /** Postpone. Critical updates come back sooner than routine ones. */
  async defer(key: string, durationMs?: number): Promise<boolean> {
    const row = this.rows.get(key)
    if (!row?.candidate) return false
    const critical = row.candidate.criticality === "critical"
    const hold = durationMs ?? (critical ? CRITICAL_DEFER_MS : DEFAULT_DEFER_MS)
    const until = this.now() + hold
    row.snapshot = {
      ...row.snapshot,
      deferredVersion: row.candidate.targetVersion,
      deferredUntil: until,
    }
    row.deferredUntil = until
    this.setState(row, "deferred", { action: null })
    await this.persistSnapshot(row)
    return true
  }

  /** Undo a skip or a defer so the row is offered on the next check. */
  async clearHold(key: string): Promise<void> {
    const row = this.rows.get(key)
    if (!row) return
    row.snapshot = {
      ...row.snapshot,
      skippedVersion: undefined,
      deferredVersion: undefined,
      deferredUntil: undefined,
      nextCheckAt: undefined,
    }
    row.skippedVersion = undefined
    row.deferredUntil = undefined
    this.emit()
    await this.persistSnapshot(row)
  }

  private async flushSnapshots(): Promise<void> {
    const settings = this.settings()
    const snapshots: Record<string, UpdateSnapshot> = { ...(settings.snapshots ?? {}) }
    for (const row of this.rows.values()) snapshots[row.key] = row.snapshot
    try {
      await this.deps.persistence.write({ snapshots })
    } catch (error) {
      this.deps.onError?.("persist", error)
    }
  }

  /** Test-only reset of in-memory state. */
  __reset(): void {
    this.rows.clear()
    this.applyInFlight.clear()
    this.sweepInFlight = null
    this.restored = false
    this.emit()
  }
}
