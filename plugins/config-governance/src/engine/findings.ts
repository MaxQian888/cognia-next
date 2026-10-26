/**
 * Normalize every source of findings into one list (ADR-0238 §7.6).
 *
 * The same rule is often reported several ways: a signal hit, the model's
 * judgment and the reference check can all land on line 12. They become one
 * finding carrying all three sources, with the judgment's verdict — the only
 * source that weighs the keep list — taking precedence over a bare signal.
 * Signals that no judgment confirmed stand alone only as low-confidence
 * flags. Order is the report's: confidence first, then group.
 */

import type { PluginAgentConfigSkillFacts } from "@cognia/plugin-sdk"

import type { Confidence, Finding, FindingGroup, FindingLocation, FindingSource } from "../model"
import type { ConflictFinding } from "./conflicts"
import { fnv1a } from "./hash"
import type { JudgedFinding, ReferenceEvidence } from "./judge"
import type { SignalHit, SignalId } from "./signals"

/** Which judgment pattern a signal is a lead for. */
export const SIGNAL_PATTERN: Readonly<Record<SignalId, string>> = {
  "pressure-language": "pressure-language",
  "hedged-requirement": "pressure-language",
  "trait-claim": "pressure-language",
  "thinking-scaffold": "thinking-scaffold",
  "thinking-depth-prose": "thinking-scaffold",
  "numeric-output-cap": "output-choreography",
  "fixed-cadence": "output-choreography",
  "step-choreography": "over-specification",
  "grader-vocabulary": "over-specification",
  "repetition-marker": "over-specification",
  "prohibition-cluster": "prohibition-without-provenance",
  "retired-model-name": "fossil",
  "update-suppressor": "fossil",
  "anti-formatting": "fossil",
  "tool-discouragement": "fossil",
  "identity-stub": "fossil",
  "history-narrative": "history-narrative",
  "date-conditional": "history-narrative",
  "trigger-enumeration": "trigger-enumeration",
  "oversized-skill": "brittle-skill",
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }
const GROUP_RANK: Record<FindingGroup, number> = {
  "brittle-config": 0,
  adherence: 1,
  "dated-text": 2,
  descriptions: 3,
  hygiene: 4,
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function findingId(surfaceKey: string, pattern: string, evidence: string): string {
  return `CFG-${fnv1a(`${surfaceKey}|${pattern}|${squash(evidence)}`)}`
}

function overlaps(a: FindingLocation, b: FindingLocation): boolean {
  if (a.surfaceKey !== b.surfaceKey) return false
  if (a.startLine === undefined || b.startLine === undefined) return a.startLine === b.startLine
  return a.startLine <= (b.endLine ?? b.startLine) && b.startLine <= (a.endLine ?? a.startLine)
}

function addSource(finding: Finding, source: FindingSource): void {
  if (!finding.sources.includes(source)) finding.sources.push(source)
}

export interface SurfaceFindingInput {
  surfaceKey: string
  judged: readonly JudgedFinding[]
  /** True when a judgment ran for this surface (an empty one counts). */
  judgedByModel: boolean
  signals: readonly SignalHit[]
  references: readonly ReferenceEvidence[]
  skill?: PluginAgentConfigSkillFacts
}

/** The findings of one surface, merged. */
export function surfaceFindings(input: SurfaceFindingInput): Finding[] {
  const out: Finding[] = input.judged.map((judged) => ({
    id: findingId(input.surfaceKey, judged.pattern, judged.evidence),
    group: judged.group,
    pattern: judged.pattern,
    location: {
      surfaceKey: input.surfaceKey,
      startLine: judged.startLine,
      endLine: judged.endLine,
    },
    evidence: judged.evidence,
    reason: judged.reason,
    confidence: judged.confidence,
    action: judged.action,
    ...(judged.replacement !== undefined ? { replacement: judged.replacement } : {}),
    ...(judged.moveTo ? { moveTo: judged.moveTo } : {}),
    ...(judged.pattern === "stale-fact" ? { proposedOnly: true } : {}),
    sources: ["judge"],
  }))

  for (const hit of input.signals) {
    const pattern = SIGNAL_PATTERN[hit.signal]
    const location = {
      surfaceKey: input.surfaceKey,
      startLine: hit.startLine,
      endLine: hit.endLine,
    }
    const confirmed = out.find(
      (finding) => finding.pattern === pattern && overlaps(finding.location, location)
    )
    if (confirmed) {
      addSource(confirmed, "signal")
      continue
    }
    // The model looked and kept it: a signal it did not confirm is not a finding.
    if (input.judgedByModel) continue
    out.push({
      id: findingId(input.surfaceKey, pattern, hit.evidence),
      group: hit.group,
      pattern,
      location,
      evidence: hit.evidence,
      reason: "",
      confidence: "low",
      action: "flag",
      sources: ["signal"],
    })
  }

  for (const ref of input.references) {
    if (ref.status !== "missing") continue
    const location = { surfaceKey: input.surfaceKey, startLine: ref.line, endLine: ref.line }
    const judged = out.find(
      (finding) => finding.pattern === "stale-fact" && overlaps(finding.location, location)
    )
    if (judged) {
      addSource(judged, "references")
      judged.confidence = "high"
      continue
    }
    out.push({
      id: findingId(input.surfaceKey, "stale-fact", ref.value),
      group: "brittle-config",
      pattern: "stale-fact",
      location,
      evidence: ref.value,
      reason: "",
      confidence: "high",
      action: "flag",
      proposedOnly: true,
      sources: ["references"],
    })
  }

  if (input.skill) {
    if (input.skill.validationErrorCount > 0) {
      out.push({
        id: findingId(input.surfaceKey, "invalid-skill", String(input.skill.validationErrorCount)),
        group: "hygiene",
        pattern: "invalid-skill",
        location: { surfaceKey: input.surfaceKey },
        evidence: String(input.skill.validationErrorCount),
        reason: "",
        confidence: "high",
        action: "flag",
        sources: ["hygiene"],
      })
    }
    if (
      input.skill.status === "enabled" &&
      input.skill.usageCount === 0 &&
      !input.skill.lastUsedAt
    ) {
      out.push({
        id: findingId(input.surfaceKey, "unused-skill", "0"),
        group: "hygiene",
        pattern: "unused-skill",
        location: { surfaceKey: input.surfaceKey },
        evidence: "0",
        reason: "",
        confidence: "low",
        action: "flag",
        sources: ["hygiene"],
      })
    }
  }
  return out
}

/** Conflict findings, on the older passage with the newer one related. */
export function conflictFindings(conflicts: readonly ConflictFinding[]): Finding[] {
  return conflicts.map((conflict) => ({
    id: findingId(
      conflict.older.surfaceKey,
      "conflict",
      `${conflict.older.text}↔${conflict.newer.surfaceKey}:${conflict.newer.startLine}`
    ),
    group: "brittle-config" as const,
    pattern: "conflict",
    location: {
      surfaceKey: conflict.older.surfaceKey,
      startLine: conflict.older.startLine,
      endLine: conflict.older.endLine,
    },
    related: [
      {
        surfaceKey: conflict.newer.surfaceKey,
        startLine: conflict.newer.startLine,
        endLine: conflict.newer.endLine,
      },
    ],
    evidence: squash(conflict.older.text),
    reason: conflict.reason,
    confidence: conflict.confidence,
    action: conflict.action,
    ...(conflict.replacement !== undefined ? { replacement: conflict.replacement } : {}),
    proposedOnly: true,
    sources: ["conflicts"],
  }))
}

/** One list, duplicates by id merged, in report order. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  const byId = new Map<string, Finding>()
  for (const finding of findings) {
    const existing = byId.get(finding.id)
    if (!existing) {
      byId.set(finding.id, { ...finding, sources: [...finding.sources] })
      continue
    }
    for (const source of finding.sources) addSource(existing, source)
    if (CONFIDENCE_RANK[finding.confidence] < CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = finding.confidence
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      GROUP_RANK[a.group] - GROUP_RANK[b.group] ||
      a.location.surfaceKey.localeCompare(b.location.surfaceKey) ||
      (a.location.startLine ?? 0) - (b.location.startLine ?? 0)
  )
}
