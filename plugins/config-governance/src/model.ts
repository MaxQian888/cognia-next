/**
 * The governance data model (ADR-0238 §7).
 *
 * One {@link Finding} shape is shared by every source — deterministic
 * signals, the reference check, the model's judgment, the cross-file conflict
 * pass and the adherence backtest — so a rule reported three ways is one
 * finding with three pieces of evidence, not three findings. A finding only
 * becomes a change through a {@link Hunk}, and only hunks the user selects are
 * applied.
 */

import type { PluginAgentConfigSurface } from "@cognia/plugin-sdk"

export const PLUGIN_ID = "cognia-config-governance"

/** The prompt-audit anti-pattern groups, plus the two Cognia adds. */
export type FindingGroup =
  /** Dated prompt text: pressure, scaffolds, over-specification, fossils, prohibitions, choreography. */
  | "dated-text"
  /** Brittle configuration: stale facts, conflicts, history, trigger enumeration, size. */
  | "brittle-config"
  /** Tool and Skill trigger descriptions. */
  | "descriptions"
  /** Rules that are not followed in practice (adherence backtest). */
  | "adherence"
  /** Skills and agents that are never used or fail validation. */
  | "hygiene"

export type Confidence = "high" | "medium" | "low"

export type FindingAction = "remove" | "rewrite" | "move" | "add" | "flag" | "enforce"

export type FindingSource =
  "signal" | "references" | "judge" | "conflicts" | "adherence" | "hygiene"

export interface FindingLocation {
  surfaceKey: string
  /** 1-based inclusive line range in the surface text; absent for whole-surface findings. */
  startLine?: number
  endLine?: number
}

export interface Finding {
  /** Stable across runs while the evidence and location hold: `CFG-` + hash. */
  id: string
  group: FindingGroup
  /** The named pattern it matches, e.g. `pressure-language`, `stale-path`, `conflict`. */
  pattern: string
  location: FindingLocation
  /** Other locations the finding involves (the other side of a conflict). */
  related?: FindingLocation[]
  /** The exact text, quoted. */
  evidence: string
  /** Why it no longer fits, grounded in the target model or the repository. */
  reason: string
  confidence: Confidence
  action: FindingAction
  /** Replacement text for `rewrite`, the added text for `add`. */
  replacement?: string
  /** Destination surface for `move`. */
  moveTo?: string
  /**
   * Edits whose newer text or current fact comes from files anyone with commit
   * access can write (conflicts, stale facts): proposed for the user to pick
   * one by one, never taken by "select all".
   */
  proposedOnly?: boolean
  sources: FindingSource[]
  /** The adherence check behind an `adherence` finding. */
  checkId?: string
}

export interface Hunk {
  findingId: string
  surfaceKey: string
  /** 1-based inclusive range the hunk replaces; an insertion has `endLine = startLine - 1`. */
  startLine: number
  endLine: number
  before: string[]
  after: string[]
  proposedOnly: boolean
}

/** What the audit read for one surface. */
export interface AuditedSurface {
  surface: PluginAgentConfigSurface
  /** Hash of the text that was audited, to tell later whether it changed. */
  textHash: string
  /** Version the hunks were computed against. */
  version?: string
  lineCount: number
  /** The text could not be made safe for a model: deterministic checks only. */
  withheld?: boolean
  /** Why the surface was not judged by the model, when it was not. */
  skipped?: "withheld" | "empty" | "model-unavailable" | "model-error"
}

export interface AuditRun {
  id: string
  workspaceId: string | null
  startedAt: number
  finishedAt: number
  /** The model the text was judged for. */
  targetModel: string
  /** The model that did the judging, when one ran. */
  judgeModel?: string
  surfaces: AuditedSurface[]
  findings: Finding[]
  hunks: Hunk[]
  /** Owners the host could not list. */
  failedSources: string[]
  /** Non-fatal problems worth showing (a model call that failed, a capped list). */
  notes: string[]
}

/** A finding's group-level counts for the overview. */
export type GroupCounts = Record<FindingGroup, number>
