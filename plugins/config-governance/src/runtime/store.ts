/**
 * What the governance plugin keeps, in its own storage (ADR-0238 §10).
 *
 * Plugin storage is capped (5 MB per plugin), so every record has a bound:
 * one latest audit per workspace with evidence clipped and lists capped, a
 * short history of counts for the drift trend, the latest derived checks and
 * backtest per workspace, and bounded lists of labels, kept findings,
 * enforcement rules, applied changes and eval comparisons. Surface texts are
 * never stored whole: only the clipped evidence (redacted, as the model saw
 * it) and the lines a hunk replaces, which stay on this device.
 */

import type { CheckResult } from "../adherence/backtest"
import type { RuleCheck } from "../adherence/checks"
import type { EnforcementRule } from "../enforcement/rules"
import type { AuditRun, Finding, FindingGroup, GroupCounts, Hunk } from "../model"

/** The storage surface this module needs (a subset of `ctx.storage`). */
export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): Promise<void>
  remove(key: string): Promise<void>
}

export const MAX_FINDINGS = 300
export const MAX_HUNKS = 200
export const MAX_EVIDENCE_CHARS = 600
export const MAX_HISTORY = 20
export const MAX_LABELS = 2_000
export const MAX_KEPT = 1_000
export const MAX_RULES = 100
export const MAX_APPLIED = 100
export const MAX_EVAL_RECORDS = 40
/** A record past this many characters is refused rather than pushing the plugin over its quota. */
export const MAX_RECORD_CHARS = 1_500_000

/** The workspace part of a key; `account` for account-only. */
export function workspaceKey(workspaceId: string | null): string {
  return workspaceId === null ? "account" : `ws:${workspaceId}`
}

export interface RunSummary {
  runId: string
  at: number
  targetModel: string
  counts: GroupCounts
  high: number
  surfaces: number
}

export interface StoredChecks {
  derivedAt: number
  checks: RuleCheck[]
  notCheckable: number
  rejected: number
}

export interface StoredAdherence {
  ranAt: number
  sessions: number
  results: CheckResult[]
  /** When set, only sessions created at or after this time were replayed. */
  since?: number
  until?: number
}

export interface AppliedChange {
  id: string
  at: number
  workspaceId: string | null
  surfaceKey: string
  /** Where the text now lives (a custom copy's key when one was created). */
  resultKey: string
  surfaceName: string
  findingIds: string[]
  hunks: number
}

export interface EvalRecord {
  id: string
  at: number
  workspaceId: string | null
  role: "baseline" | "candidate"
  datasetId: string
  model: string
  runIds: string[]
  passAt1?: number
  totalCostUsd?: number
  /** The applied change a candidate run measures. */
  changeId?: string
}

export class RecordTooLargeError extends Error {
  readonly code = "record_too_large"
  constructor(readonly key: string) {
    super(`the record for ${key} is too large to keep`)
    this.name = "RecordTooLargeError"
  }
}

export const GROUPS: readonly FindingGroup[] = [
  "brittle-config",
  "adherence",
  "dated-text",
  "descriptions",
  "hygiene",
]

export function countGroups(findings: readonly Finding[]): GroupCounts {
  const counts = Object.fromEntries(GROUPS.map((group) => [group, 0])) as GroupCounts
  for (const finding of findings) counts[finding.group]++
  return counts
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The run as it is kept: lists capped, evidence clipped, hunks of dropped findings dropped. */
export function compactRun(run: AuditRun): AuditRun {
  const findings = run.findings.slice(0, MAX_FINDINGS).map((finding) => ({
    ...finding,
    evidence: clip(finding.evidence, MAX_EVIDENCE_CHARS),
  }))
  const kept = new Set(findings.map((finding) => finding.id))
  const hunks: Hunk[] = run.hunks.filter((hunk) => kept.has(hunk.findingId)).slice(0, MAX_HUNKS)
  const notes = [...run.notes]
  if (run.findings.length > findings.length) notes.push(`findings-capped:${run.findings.length}`)
  return { ...run, findings, hunks, notes }
}

export class GovernanceStore {
  constructor(private readonly storage: StorageLike) {}

  private async write<T>(key: string, value: T): Promise<void> {
    if (JSON.stringify(value).length > MAX_RECORD_CHARS) throw new RecordTooLargeError(key)
    await this.storage.set(key, value)
  }

  private async list<T>(key: string): Promise<T[]> {
    const value = await this.storage.get<T[]>(key)
    return Array.isArray(value) ? value : []
  }

  // Audit runs -----------------------------------------------------------------

  async latestRun(workspaceId: string | null): Promise<AuditRun | undefined> {
    return this.storage.get<AuditRun>(`run/${workspaceKey(workspaceId)}`)
  }

  async saveRun(run: AuditRun): Promise<AuditRun> {
    const compact = compactRun(run)
    await this.write(`run/${workspaceKey(run.workspaceId)}`, compact)
    const history = await this.history(run.workspaceId)
    const summary: RunSummary = {
      runId: run.id,
      at: run.finishedAt,
      targetModel: run.targetModel,
      counts: countGroups(run.findings),
      high: run.findings.filter((finding) => finding.confidence === "high").length,
      surfaces: run.surfaces.length,
    }
    await this.write(
      `history/${workspaceKey(run.workspaceId)}`,
      [summary, ...history].slice(0, MAX_HISTORY)
    )
    return compact
  }

  async history(workspaceId: string | null): Promise<RunSummary[]> {
    return this.list<RunSummary>(`history/${workspaceKey(workspaceId)}`)
  }

  // Kept findings ("this rule should exist") ---------------------------------------

  async keptFindings(workspaceId: string | null): Promise<Set<string>> {
    return new Set(await this.list<string>(`kept/${workspaceKey(workspaceId)}`))
  }

  async setKept(workspaceId: string | null, findingId: string, kept: boolean): Promise<void> {
    const key = `kept/${workspaceKey(workspaceId)}`
    const current = (await this.list<string>(key)).filter((id) => id !== findingId)
    await this.write(key, (kept ? [findingId, ...current] : current).slice(0, MAX_KEPT))
  }

  // Adherence -----------------------------------------------------------------

  async checks(workspaceId: string | null): Promise<StoredChecks | undefined> {
    return this.storage.get<StoredChecks>(`checks/${workspaceKey(workspaceId)}`)
  }

  async saveChecks(workspaceId: string | null, checks: StoredChecks): Promise<void> {
    await this.write(`checks/${workspaceKey(workspaceId)}`, checks)
  }

  async adherence(workspaceId: string | null): Promise<StoredAdherence | undefined> {
    return this.storage.get<StoredAdherence>(`adherence/${workspaceKey(workspaceId)}`)
  }

  async saveAdherence(workspaceId: string | null, adherence: StoredAdherence): Promise<void> {
    await this.write(`adherence/${workspaceKey(workspaceId)}`, adherence)
  }

  async falseMatches(): Promise<Set<string>> {
    return new Set(await this.list<string>("labels/false-match"))
  }

  async setFalseMatch(sampleKey: string, falseMatch: boolean): Promise<void> {
    const current = (await this.list<string>("labels/false-match")).filter(
      (key) => key !== sampleKey
    )
    await this.write(
      "labels/false-match",
      (falseMatch ? [sampleKey, ...current] : current).slice(0, MAX_LABELS)
    )
  }

  async clearFalseMatches(checkId: string): Promise<void> {
    const current = await this.list<string>("labels/false-match")
    await this.write(
      "labels/false-match",
      current.filter((key) => !key.startsWith(`${checkId}|`))
    )
  }

  // Enforcement ----------------------------------------------------------------

  async rules(): Promise<EnforcementRule[]> {
    return this.list<EnforcementRule>("enforcement/rules")
  }

  async saveRules(rules: readonly EnforcementRule[]): Promise<void> {
    if (rules.length > MAX_RULES) throw new RecordTooLargeError("enforcement/rules")
    await this.write("enforcement/rules", rules)
  }

  // Applied changes and evals --------------------------------------------------

  async appliedChanges(): Promise<AppliedChange[]> {
    return this.list<AppliedChange>("applied")
  }

  async recordApplied(change: AppliedChange): Promise<void> {
    const current = await this.appliedChanges()
    await this.write("applied", [change, ...current].slice(0, MAX_APPLIED))
  }

  async evalRecords(): Promise<EvalRecord[]> {
    return this.list<EvalRecord>("evals")
  }

  async recordEval(record: EvalRecord): Promise<void> {
    const current = await this.evalRecords()
    await this.write("evals", [record, ...current].slice(0, MAX_EVAL_RECORDS))
  }

  // Meta -----------------------------------------------------------------------

  async lastWorkspace(): Promise<string | null | undefined> {
    const value = await this.storage.get<{ id: string | null }>("meta/last-workspace")
    return value ? value.id : undefined
  }

  async setLastWorkspace(workspaceId: string | null): Promise<void> {
    await this.write("meta/last-workspace", { id: workspaceId })
  }

  /** Workspaces with a stored audit, for the drift check. */
  async auditedWorkspaces(): Promise<Array<string | null>> {
    return this.list<string | null>("meta/audited-workspaces")
  }

  async markAudited(workspaceId: string | null): Promise<void> {
    const current = (await this.auditedWorkspaces()).filter((id) => id !== workspaceId)
    await this.write("meta/audited-workspaces", [workspaceId, ...current].slice(0, 20))
  }
}
