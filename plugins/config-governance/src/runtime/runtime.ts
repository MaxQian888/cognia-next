/**
 * The governance runtime: one object per activation that owns the plugin's
 * state and is the only thing the view, the tools, the command, the hooks and
 * the scheduled task talk to (ADR-0238 §10).
 *
 * It depends on {@link GovernanceHost}, a narrow projection of the plugin
 * context, so it runs in tests without a host. Every long operation reports
 * progress through {@link GovernanceRuntime.subscribe}, which the view uses to
 * re-render; nothing here renders.
 */

import type { PluginAgentConfigAPI } from "@cognia/plugin-sdk"

import { adherenceFindings } from "../adherence/findings"
import { sampleKey } from "../adherence/backtest"
import type { RuleCheck } from "../adherence/checks"
import { normalizeToolCall } from "../adherence/events"
import type { GovernanceConfig } from "../config"
import { textFingerprint } from "../engine/hash"
import { createLlmBridge, type LlmChatSource } from "../engine/llm"
import {
  EnforcementEngine,
  ruleLocation,
  toolResultText,
  type EnforcementMode,
  type EnforcementRule,
} from "../enforcement/rules"
import type { AuditRun, Finding } from "../model"
import { PROMPT_IDS } from "../prompts"
import { compareAdherence, readEvalOutcome, type CheckComparison } from "../verify/compare"
import { deriveChecks, runAdherence, type SessionSourceLike } from "./adherence"
import { applySelected, type SurfaceApplyResult } from "./apply"
import { runAudit } from "./audit"
import {
  GovernanceStore,
  type EvalRecord,
  type StorageLike,
  type StoredAdherence,
  type StoredChecks,
} from "./store"

export interface WorkspaceInfo {
  id: string
  name: string
  roots: string[]
}

export interface GovernanceHost {
  agentConfig: PluginAgentConfigAPI
  storage: StorageLike
  ai: LlmChatSource & { getDefaultModel(): string }
  sessions: SessionSourceLike & {
    getSession(id: string): Promise<{ projectId?: string } | null>
  }
  listWorkspaces(): Promise<WorkspaceInfo[]>
  currentWorkspaceId(): string | null
  resolvePrompt(id: string, values?: Record<string, string>): Promise<string>
  runEval(args: { datasetId: string; model: string; cwd?: string }): Promise<unknown>
  listEvalDatasets(): Promise<Array<{ id: string; name: string }>>
  config(): GovernanceConfig
  notify(title: string, body: string): void
  /** Move the app to an in-app route. */
  navigate(href: string): boolean
  t(key: string, params?: Record<string, string | number>): string
  now(): number
  newId(): string
  log(message: string, error?: unknown): void
}

export type BusyKind = "audit" | "derive" | "backtest" | "apply" | "verify" | "eval"

export interface RuntimeStatus {
  busy?: { kind: BusyKind; workspaceId: string | null; done: number; total: number; label: string }
  /** `code` when the failure has one, so the view can say it in the user's language. */
  error?: { kind: BusyKind; message: string; code?: string }
  /** Bumped on every stored change, for views keyed on it. */
  revision: number
}

/**
 * Whether a deterministic finding was already reported. The judged copy of a
 * stale fact quotes the line, the deterministic one names the path, so the
 * ids differ; match on surface, pattern and evidence containment as well.
 */
export function knownFinding(previous: readonly Finding[], finding: Finding): boolean {
  return previous.some(
    (entry) =>
      entry.id === finding.id ||
      (entry.location.surfaceKey === finding.location.surfaceKey &&
        entry.pattern === finding.pattern &&
        (entry.evidence.includes(finding.evidence) || finding.evidence.includes(entry.evidence)))
  )
}

/**
 * The Prompt Center deep link (`/settings?section=prompts&resource=&workspace=`),
 * the same shape the host's `promptCenterHref` builds. Agent files are not
 * Prompt Center resources and have no link.
 */
export function promptCenterHref(surfaceKey: string, workspaceId: string | null): string {
  const search = new URLSearchParams({ section: "prompts", resource: surfaceKey })
  if (workspaceId) search.set("workspace", workspaceId)
  return `/settings?${search.toString()}`
}

export function hasPromptCenterEntry(surfaceKey: string): boolean {
  return !surfaceKey.startsWith("agent-file:")
}

export class GovernanceBusyError extends Error {
  readonly code = "governance_busy"
  constructor() {
    super("another governance operation is running")
    this.name = "GovernanceBusyError"
  }
}

function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  return typeof code === "string" ? code : undefined
}

/** What a tool returns in place of text the host could not make safe. */
export const WITHHELD_TEXT = "[withheld: contains data that cannot be shared]"

export class GovernanceRuntime {
  readonly store: GovernanceStore
  private readonly enforcement = new EnforcementEngine()
  private readonly listeners = new Set<() => void>()
  private readonly sessionWorkspace = new Map<string, string | null>()
  private status: RuntimeStatus = { revision: 0 }
  private abort?: AbortController

  constructor(private readonly host: GovernanceHost) {
    this.store = new GovernanceStore(host.storage)
  }

  // State and subscription ------------------------------------------------------

  getStatus(): RuntimeStatus {
    return this.status
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setStatus(next: Partial<RuntimeStatus>): void {
    this.status = { ...this.status, ...next }
    for (const listener of this.listeners) listener()
  }

  private changed(): void {
    this.setStatus({ revision: this.status.revision + 1 })
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async exclusive<T>(
    kind: BusyKind,
    workspaceId: string | null,
    task: (
      signal: AbortSignal,
      progress: (done: number, total: number, label: string) => void
    ) => Promise<T>
  ): Promise<T> {
    if (this.status.busy) throw new GovernanceBusyError()
    const controller = new AbortController()
    this.abort = controller
    this.setStatus({ busy: { kind, workspaceId, done: 0, total: 0, label: "" }, error: undefined })
    try {
      const result = await task(controller.signal, (done, total, label) =>
        this.setStatus({ busy: { kind, workspaceId, done, total, label } })
      )
      this.setStatus({ busy: undefined })
      this.changed()
      return result
    } catch (error) {
      this.setStatus({
        busy: undefined,
        error: {
          kind,
          message: error instanceof Error ? error.message : String(error),
          ...(errorCode(error) ? { code: errorCode(error) } : {}),
        },
      })
      throw error
    } finally {
      if (this.abort === controller) this.abort = undefined
    }
  }

  // Workspaces and models ---------------------------------------------------------

  async workspaces(): Promise<WorkspaceInfo[]> {
    return this.host.listWorkspaces()
  }

  /** The workspace to show first: the active one, else the last one looked at. */
  async defaultWorkspace(): Promise<string | null> {
    const current = this.host.currentWorkspaceId()
    if (current) return current
    const last = await this.store.lastWorkspace()
    return last === undefined ? null : last
  }

  async rootsOf(workspaceId: string | null): Promise<string[]> {
    if (!workspaceId) return []
    const workspace = (await this.host.listWorkspaces()).find((entry) => entry.id === workspaceId)
    return workspace?.roots ?? []
  }

  enforcementEnabled(): boolean {
    return this.host.config().enforcementEnabled
  }

  /** The model the configuration is judged for. */
  targetModel(): string {
    return this.host.config().targetModel || this.host.ai.getDefaultModel() || "unknown"
  }

  private judge() {
    const model = this.host.config().auditModel || this.host.ai.getDefaultModel()
    return { model, llm: model ? createLlmBridge(this.host.ai, model) : undefined }
  }

  // Audit -------------------------------------------------------------------------

  async audit(workspaceId: string | null, surfaceKeys?: readonly string[]): Promise<AuditRun> {
    return this.exclusive("audit", workspaceId, async (signal, progress) => {
      await this.store.setLastWorkspace(workspaceId)
      const run = await this.auditOnce(workspaceId, signal, progress, surfaceKeys)
      const merged = surfaceKeys ? await this.mergeRun(workspaceId, run, surfaceKeys) : run
      const saved = await this.store.saveRun(merged)
      await this.store.markAudited(workspaceId)
      return saved
    })
  }

  private async auditOnce(
    workspaceId: string | null,
    signal: AbortSignal,
    progress: (done: number, total: number, label: string) => void,
    surfaceKeys?: readonly string[],
    deterministicOnly = false
  ): Promise<AuditRun> {
    const { model, llm } = this.judge()
    return runAudit(
      {
        agentConfig: this.host.agentConfig,
        ...(llm && !deterministicOnly ? { llm } : {}),
        resolvePrompt: (id) => this.host.resolvePrompt(id),
        now: () => this.host.now(),
        newId: () => this.host.newId(),
        signal,
        onProgress: progress,
      },
      {
        workspaceId,
        includeShipped: this.host.config().auditShipped,
        targetModel: this.targetModel(),
        ...(model ? { judgeModel: model } : {}),
        ...(surfaceKeys ? { surfaceKeys } : {}),
      }
    )
  }

  /** A partial re-audit replaces only what it re-read. */
  private async mergeRun(
    workspaceId: string | null,
    partial: AuditRun,
    keys: readonly string[]
  ): Promise<AuditRun> {
    const previous = await this.store.latestRun(workspaceId)
    if (!previous) return partial
    const touched = new Set(keys)
    const touches = (finding: Finding) =>
      touched.has(finding.location.surfaceKey) ||
      (finding.related ?? []).some((location) => touched.has(location.surfaceKey))
    const dropped = new Set(previous.findings.filter(touches).map((finding) => finding.id))
    return {
      ...previous,
      id: partial.id,
      finishedAt: partial.finishedAt,
      surfaces: [
        ...previous.surfaces.filter((entry) => !touched.has(entry.surface.key)),
        ...partial.surfaces,
      ],
      findings: [
        ...previous.findings.filter((finding) => !dropped.has(finding.id)),
        ...partial.findings,
      ],
      hunks: [
        ...previous.hunks.filter(
          (hunk) => !dropped.has(hunk.findingId) && !touched.has(hunk.surfaceKey)
        ),
        ...partial.hunks,
      ],
      notes: partial.notes,
    }
  }

  async surfaces(workspaceId: string | null) {
    return this.host.agentConfig.listSurfaces({ workspaceId })
  }

  async facts(workspaceId: string | null) {
    return this.host.agentConfig.readFacts({ workspaceId })
  }

  /**
   * Text an agent tool hands to a model. Findings drawn from a withheld
   * surface quote it unredacted for the view; a tool result reaches the model,
   * so it gets the host redaction or a marker.
   */
  forModel(text: string): string {
    return this.host.agentConfig.redactForModel(text) ?? WITHHELD_TEXT
  }

  async latestRun(workspaceId: string | null): Promise<AuditRun | undefined> {
    return this.store.latestRun(workspaceId)
  }

  /** Audit findings plus adherence findings, in one list. */
  async findings(workspaceId: string | null): Promise<Finding[]> {
    const [run, checks, adherence] = await Promise.all([
      this.store.latestRun(workspaceId),
      this.store.checks(workspaceId),
      this.store.adherence(workspaceId),
    ])
    const fromAdherence =
      checks && adherence ? adherenceFindings(checks.checks, adherence.results) : []
    return [...fromAdherence, ...(run?.findings ?? [])]
  }

  async setKept(workspaceId: string | null, findingId: string, kept: boolean): Promise<void> {
    await this.store.setKept(workspaceId, findingId, kept)
    this.changed()
  }

  async apply(
    workspaceId: string | null,
    findingIds: ReadonlySet<string>
  ): Promise<SurfaceApplyResult[]> {
    const run = await this.store.latestRun(workspaceId)
    if (!run) return []
    const results = await this.exclusive("apply", workspaceId, async () =>
      applySelected(
        {
          agentConfig: this.host.agentConfig,
          now: () => this.host.now(),
          newId: () => this.host.newId(),
          summarize: (name, hunks) => this.host.t("apply.summary", { name, count: hunks }),
          record: (change) => this.store.recordApplied(change),
        },
        run,
        findingIds
      )
    )
    // Re-check what was written, so the list shows what is left, not what was fixed.
    const recheck = [
      ...new Set(
        results
          .filter((result) => result.status === "applied" || result.status === "stale")
          .flatMap((result) => [result.surfaceKey, ...(result.resultKey ? [result.resultKey] : [])])
      ),
    ]
    if (recheck.length > 0) {
      try {
        await this.audit(workspaceId, recheck)
      } catch (error) {
        this.host.log("re-audit after apply failed", error)
      }
    }
    return results
  }

  // Adherence ---------------------------------------------------------------------

  async deriveChecks(workspaceId: string | null): Promise<StoredChecks> {
    const { llm } = this.judge()
    if (!llm) throw new Error(this.host.t("errors.noModel"))
    return this.exclusive("derive", workspaceId, async (signal) => {
      const checks = await deriveChecks(
        {
          agentConfig: this.host.agentConfig,
          llm,
          resolvePrompt: (id) => this.host.resolvePrompt(id),
          now: () => this.host.now(),
          signal,
        },
        workspaceId
      )
      await this.store.saveChecks(workspaceId, checks)
      return checks
    })
  }

  async backtest(workspaceId: string | null): Promise<StoredAdherence | undefined> {
    const checks = await this.store.checks(workspaceId)
    if (!checks) return undefined
    return this.exclusive("backtest", workspaceId, async (signal) => {
      const adherence = await this.replay(workspaceId, checks.checks, signal)
      await this.store.saveAdherence(workspaceId, adherence)
      return adherence
    })
  }

  private async replay(
    workspaceId: string | null,
    checks: readonly RuleCheck[],
    signal: AbortSignal,
    window: { since?: number; until?: number } = {}
  ): Promise<StoredAdherence> {
    return runAdherence(this.host.sessions, {
      workspaceId,
      checks,
      limit: this.host.config().backtestSessionLimit,
      falseMatches: await this.store.falseMatches(),
      roots: await this.rootsOf(workspaceId),
      now: () => this.host.now(),
      signal,
      ...window,
    })
  }

  async setFalseMatch(
    checkId: string,
    sessionId: string,
    order: number,
    falseMatch: boolean
  ): Promise<void> {
    await this.store.setFalseMatch(sampleKey(checkId, sessionId, order), falseMatch)
    this.changed()
  }

  async clearFalseMatches(checkId: string): Promise<void> {
    await this.store.clearFalseMatches(checkId)
    this.changed()
  }

  // Enforcement -------------------------------------------------------------------

  async loadEnforcement(): Promise<void> {
    const rules = await this.store.rules()
    this.enforcement.setRules(this.host.config().enforcementEnabled ? rules : [])
  }

  async adopt(
    check: RuleCheck,
    mode: EnforcementMode,
    workspaceId: string | null,
    findingId?: string
  ): Promise<EnforcementRule> {
    const rules = await this.store.rules()
    const existing = rules.find(
      (rule) => rule.check.id === check.id && rule.workspaceId === workspaceId
    )
    const rule: EnforcementRule = existing
      ? { ...existing, mode, enabled: true }
      : {
          id: `ENF-${textFingerprint(`${check.id}|${workspaceId ?? ""}`).slice(0, 12)}`,
          check,
          mode,
          workspaceId,
          enabled: true,
          createdAt: this.host.now(),
          ...(findingId ? { findingId } : {}),
        }
    await this.store.saveRules([rule, ...rules.filter((entry) => entry.id !== rule.id)])
    await this.loadEnforcement()
    this.changed()
    return rule
  }

  async updateRule(
    id: string,
    patch: Partial<Pick<EnforcementRule, "mode" | "enabled">>
  ): Promise<void> {
    const rules = await this.store.rules()
    await this.store.saveRules(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))
    await this.loadEnforcement()
    this.changed()
  }

  async removeRule(id: string): Promise<void> {
    const rules = await this.store.rules()
    await this.store.saveRules(rules.filter((rule) => rule.id !== id))
    await this.loadEnforcement()
    this.changed()
  }

  private async workspaceOfSession(sessionId: string): Promise<string | null> {
    if (this.sessionWorkspace.has(sessionId)) return this.sessionWorkspace.get(sessionId) ?? null
    let projectId: string | null = null
    try {
      projectId = (await this.host.sessions.getSession(sessionId))?.projectId ?? null
    } catch {
      projectId = null
    }
    this.sessionWorkspace.set(sessionId, projectId)
    if (this.sessionWorkspace.size > 200) {
      const oldest = this.sessionWorkspace.keys().next().value
      if (oldest !== undefined) this.sessionWorkspace.delete(oldest)
    }
    return projectId
  }

  onPrompt(sessionId: string): void {
    if (this.enforcement.hasRules()) this.enforcement.onPrompt(sessionId)
  }

  /** `onPreToolUse`: the deny reason, when an adopted rule blocks the call. */
  async preToolUse(
    toolName: string,
    args: unknown,
    sessionId: string
  ): Promise<string | undefined> {
    if (!this.enforcement.hasRules()) return undefined
    const decision = this.enforcement.pre(
      sessionId,
      await this.workspaceOfSession(sessionId),
      normalizeToolCall(toolName, args)
    )
    if (!decision.blockedBy) return undefined
    return this.host.resolvePrompt(PROMPT_IDS.block, {
      rule: decision.blockedBy.check.rule.text.slice(0, 600),
      location: ruleLocation(decision.blockedBy).slice(0, 200),
    })
  }

  /** `onPostToolUse`: the result with reminders appended, when any apply and the result is text. */
  async postToolUse(
    toolName: string,
    args: unknown,
    result: unknown,
    sessionId: string
  ): Promise<string | undefined> {
    if (!this.enforcement.hasRules()) return undefined
    const decision = this.enforcement.post(
      sessionId,
      await this.workspaceOfSession(sessionId),
      normalizeToolCall(toolName, args)
    )
    if (decision.reminders.length === 0) return undefined
    const text = toolResultText(result)
    if (text === null) return undefined
    const reminders = await Promise.all(
      decision.reminders.map((rule) =>
        this.host.resolvePrompt(PROMPT_IDS.remind, {
          rule: rule.check.rule.text.slice(0, 600),
          location: ruleLocation(rule).slice(0, 200),
        })
      )
    )
    return `${text}\n\n${reminders.join("\n")}`
  }

  forgetSessions(): void {
    this.enforcement.forget()
    this.sessionWorkspace.clear()
  }

  // Verification ------------------------------------------------------------------

  /** Adherence before and after one applied change, with the current checks. */
  async compareSinceChange(changeId: string): Promise<CheckComparison[] | undefined> {
    const change = (await this.store.appliedChanges()).find((entry) => entry.id === changeId)
    if (!change) return undefined
    const checks = await this.store.checks(change.workspaceId)
    if (!checks || checks.checks.length === 0) return []
    return this.exclusive("verify", change.workspaceId, async (signal) => {
      const before = await this.replay(change.workspaceId, checks.checks, signal, {
        until: change.at,
      })
      const after = await this.replay(change.workspaceId, checks.checks, signal, {
        since: change.at,
      })
      return compareAdherence(before.results, after.results)
    })
  }

  async evalDatasets(): Promise<Array<{ id: string; name: string }>> {
    return this.host.listEvalDatasets()
  }

  async runEval(input: {
    role: EvalRecord["role"]
    workspaceId: string | null
    datasetId: string
    model: string
    changeId?: string
  }): Promise<EvalRecord> {
    return this.exclusive("eval", input.workspaceId, async () => {
      const [cwd] = await this.rootsOf(input.workspaceId)
      const outcome = readEvalOutcome(
        await this.host.runEval({
          datasetId: input.datasetId,
          model: input.model,
          ...(cwd ? { cwd } : {}),
        })
      )
      const record: EvalRecord = {
        id: this.host.newId(),
        at: this.host.now(),
        workspaceId: input.workspaceId,
        role: input.role,
        datasetId: input.datasetId,
        model: input.model,
        runIds: outcome.runIds,
        ...(outcome.passAt1 !== undefined ? { passAt1: outcome.passAt1 } : {}),
        ...(outcome.totalCostUsd !== undefined ? { totalCostUsd: outcome.totalCostUsd } : {}),
        ...(input.changeId ? { changeId: input.changeId } : {}),
      }
      await this.store.recordEval(record)
      return record
    })
  }

  // Drift (scheduled) -------------------------------------------------------------

  /**
   * The weekly drift check: a deterministic re-audit (no model call, no cost)
   * of every audited workspace, telling the user when a surface changed or a
   * new high-confidence finding — a stale path or script — appeared.
   */
  async driftCheck(): Promise<{ workspaces: number; changed: number; newHigh: number }> {
    if (this.status.busy) throw new GovernanceBusyError()
    const workspaces = await this.store.auditedWorkspaces()
    let changed = 0
    let newHigh = 0
    const controller = new AbortController()
    for (const workspaceId of workspaces) {
      const previous = await this.store.latestRun(workspaceId)
      if (!previous) continue
      const current = await this.auditOnce(
        workspaceId,
        controller.signal,
        () => {},
        undefined,
        true
      )
      const hashes = new Map(previous.surfaces.map((entry) => [entry.surface.key, entry.textHash]))
      changed += current.surfaces.filter(
        (entry) => hashes.get(entry.surface.key) !== entry.textHash
      ).length
      newHigh += current.findings.filter(
        (finding) => finding.confidence === "high" && !knownFinding(previous.findings, finding)
      ).length
    }
    if (changed > 0 || newHigh > 0) {
      this.host.notify(
        this.host.t("drift.title"),
        this.host.t("drift.body", { changed, findings: newHigh })
      )
    }
    return { workspaces: workspaces.length, changed, newHigh }
  }

  /** Open a surface in the Prompt Center, where its owner's editor and history live. */
  openInPromptCenter(surfaceKey: string, workspaceId: string | null): boolean {
    return this.host.navigate(promptCenterHref(surfaceKey, workspaceId))
  }

  /** The default model differs from the one the latest audit judged for. */
  async modelChangedSince(workspaceId: string | null): Promise<string | undefined> {
    const run = await this.store.latestRun(workspaceId)
    if (!run) return undefined
    const target = this.targetModel()
    return run.targetModel !== target ? run.targetModel : undefined
  }
}
