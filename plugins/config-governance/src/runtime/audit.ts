/**
 * The audit pipeline (ADR-0238 §7): should each rule exist?
 *
 * Per surface: read it through the host, segment it, run the deterministic
 * signals, check the paths and scripts it names against the repository, date
 * its lines from version control, then — when a model is available and the
 * text can be made safe — ask for a judgment and keep only what the evidence
 * supports. Across surfaces: one conflict pass over the rule pairs that rule
 * on the same point. Last, findings are merged and ranked, and hunks are cut
 * for the ones that warrant an edit.
 *
 * The model only ever sees text that `redactForModel` returned; a surface it
 * cannot make safe gets the deterministic checks alone. Nothing here writes.
 */

import type {
  PluginAgentConfigAPI,
  PluginAgentConfigFacts,
  PluginAgentConfigSurface,
} from "@cognia/plugin-sdk"

import { buildConflictPairs, buildConflictRequest, parseConflictAnswer } from "../engine/conflicts"
import { buildHunks, type HunkSurface } from "../engine/diff"
import { conflictFindings, rankFindings, surfaceFindings } from "../engine/findings"
import { textFingerprint } from "../engine/hash"
import {
  buildJudgeRequest,
  destinationAliases,
  parseJudgement,
  type ReferenceEvidence,
} from "../engine/judge"
import type { LlmBridge } from "../engine/llm"
import { findOverlaps, type SurfaceUnits } from "../engine/overlap"
import { extractReferenceClaims } from "../engine/references"
import { instructionUnits, segmentRules, type RuleUnit } from "../engine/segment"
import { scanSignals } from "../engine/signals"
import type { AuditedSurface, AuditRun, Finding } from "../model"
import { PROMPT_IDS } from "../prompts"

export interface AuditDeps {
  agentConfig: PluginAgentConfigAPI
  /** Absent when no model is configured: the audit runs its deterministic checks only. */
  llm?: LlmBridge
  /** The system text for one of this plugin's prompts. */
  resolvePrompt(id: string): Promise<string>
  now(): number
  newId(): string
  signal?: AbortSignal
  onProgress?(done: number, total: number, label: string): void
}

export interface AuditOptions {
  workspaceId: string | null
  /** Audit shipped, unmodified prompts too (they rarely need a change). */
  includeShipped: boolean
  /** The model the configuration is judged for. */
  targetModel: string
  judgeModel?: string
  /** Audit only these surfaces. */
  surfaceKeys?: readonly string[]
  maxSurfaces?: number
}

export const DEFAULT_MAX_SURFACES = 60

/** Surfaces whose text is a file in the repository: paths and scripts in them are checkable. */
const FILE_LIKE = new Set(["instruction-file", "agent-file", "skill", "workspace-instructions"])
/** Surfaces whose rules load together into one agent's context, for the conflict pass. */
const CONFLICT_SOURCES = new Set([
  "instruction-file",
  "agent-file",
  "workspace-instructions",
  "app-setting",
])
/** Surfaces a `move` may target. */
const MOVE_TARGETS = new Set(["instruction-file", "agent-file", "skill", "workspace-instructions"])

const PRIORITY: Record<string, number> = {
  "instruction-file": 0,
  "agent-file": 1,
  "workspace-instructions": 2,
  skill: 3,
  "app-setting": 4,
  character: 5,
  "subagent-template": 6,
  "team-template": 7,
  "custom-mode": 8,
  preset: 9,
  "composer-template": 10,
}

export class AuditAbortedError extends Error {
  readonly code = "governance_cancelled"
  constructor() {
    super("the audit was cancelled")
    this.name = "AuditAbortedError"
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AuditAbortedError()
}

export function selectSurfaces(
  surfaces: readonly PluginAgentConfigSurface[],
  options: Pick<AuditOptions, "includeShipped" | "surfaceKeys" | "maxSurfaces">
): { selected: PluginAgentConfigSurface[]; capped: number } {
  const wanted = options.surfaceKeys ? new Set(options.surfaceKeys) : undefined
  const eligible = surfaces
    .filter((surface) => !surface.unavailable)
    .filter((surface) => (wanted ? wanted.has(surface.key) : true))
    .filter((surface) => wanted || options.includeShipped || !surface.builtIn || surface.modified)
    .sort(
      (a, b) =>
        (PRIORITY[a.source] ?? 99) - (PRIORITY[b.source] ?? 99) ||
        (a.loadOrder ?? 0) - (b.loadOrder ?? 0) ||
        a.name.localeCompare(b.name)
    )
  const max = options.maxSurfaces ?? DEFAULT_MAX_SURFACES
  return { selected: eligible.slice(0, max), capped: Math.max(0, eligible.length - max) }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

interface SurfaceWork {
  surface: PluginAgentConfigSurface
  text: string
  redacted: string | null
  units: RuleUnit[]
  lineDates: Map<number, string>
  audited: AuditedSurface
}

async function referenceEvidence(
  deps: AuditDeps,
  workspaceId: string | null,
  text: string
): Promise<ReferenceEvidence[]> {
  const claims = extractReferenceClaims(text)
  if (claims.paths.length === 0 && claims.scripts.length === 0) return []
  const check = await deps.agentConfig.checkReferences({
    workspaceId,
    paths: claims.paths.map((claim) => claim.value),
    scripts: claims.scripts.map((claim) => claim.value),
  })
  const pathStatus = new Map(check.paths.map((row) => [row.path, row.status]))
  const scriptStatus = new Map(check.scripts.map((row) => [row.name, row.status]))
  return [
    ...claims.paths.map((claim) => ({
      kind: "path" as const,
      value: claim.value,
      line: claim.line,
      status: pathStatus.get(claim.value) ?? "unchecked",
    })),
    ...claims.scripts.map((claim) => ({
      kind: "script" as const,
      value: claim.value,
      line: claim.line,
      // The judge and the findings speak of a missing reference in one word.
      status:
        scriptStatus.get(claim.value) === "undefined"
          ? "missing"
          : (scriptStatus.get(claim.value) ?? "unchecked"),
    })),
  ]
}

export async function runAudit(deps: AuditDeps, options: AuditOptions): Promise<AuditRun> {
  const startedAt = deps.now()
  const notes: string[] = []
  const listing = await deps.agentConfig.listSurfaces({ workspaceId: options.workspaceId })
  const { selected, capped } = selectSurfaces(listing.surfaces, options)
  if (capped > 0) notes.push(`surfaces-capped:${capped}`)

  let facts: PluginAgentConfigFacts | undefined
  try {
    facts = await deps.agentConfig.readFacts({ workspaceId: options.workspaceId })
  } catch {
    notes.push("facts-unavailable")
  }

  const destinations = listing.surfaces
    .filter((surface) => MOVE_TARGETS.has(surface.source) && surface.edit !== "owner-only")
    .map((surface) => ({ key: surface.key, name: surface.name }))
  const judgePrompt = deps.llm ? await deps.resolvePrompt(PROMPT_IDS.judge) : ""

  const work: SurfaceWork[] = []
  const findings: Finding[] = []
  const total = selected.length + (deps.llm ? 1 : 0)
  let done = 0

  for (const surface of selected) {
    throwIfAborted(deps.signal)
    deps.onProgress?.(done, total, surface.name)
    const document = await deps.agentConfig.readSurface(surface.key, {
      workspaceId: options.workspaceId,
    })
    done++
    if (!document) continue
    const text = document.text
    const lines = text.split("\n")
    const audited: AuditedSurface = {
      surface,
      textHash: textFingerprint(text),
      ...(document.version ? { version: document.version } : {}),
      lineCount: lines.length,
    }
    if (!text.trim()) {
      work.push({
        surface,
        text,
        redacted: text,
        units: [],
        lineDates: new Map(),
        audited: { ...audited, skipped: "empty" },
      })
      continue
    }
    const redacted = deps.agentConfig.redactForModel(text)
    // Signals and reference claims quote the text into the judge request and
    // into findings an agent tool can read, so they are drawn from the
    // redacted copy (line-preserving, so line numbers still match the
    // original). A withheld surface never reaches a model; its signals stay local.
    const visible = redacted ?? text
    const units = segmentRules(visible)
    const signals = scanSignals(units, visible.split("\n"), {
      isSkill: surface.source === "skill",
    })
    const references = FILE_LIKE.has(surface.source)
      ? await referenceEvidence(deps, options.workspaceId, visible).catch(() => {
          notes.push(`references-failed:${surface.key}`)
          return []
        })
      : []
    const lineDates = new Map<number, string>()
    if (surface.path) {
      const provenance = await deps.agentConfig.readProvenance(surface.key).catch(() => null)
      for (const row of provenance ?? []) {
        if (row.commit && row.authoredAtMs > 0) lineDates.set(row.line, isoDate(row.authoredAtMs))
      }
    }

    let judged: ReturnType<typeof parseJudgement> = []
    let judgedByModel = false
    if (redacted === null) {
      audited.withheld = true
      audited.skipped = "withheld"
    } else if (!deps.llm) {
      audited.skipped = "model-unavailable"
    } else {
      const targets = destinations.filter((entry) => entry.key !== surface.key)
      try {
        const answer = await deps.llm.complete(
          [
            { role: "system", content: judgePrompt },
            {
              role: "user",
              content: buildJudgeRequest({
                surface,
                text: redacted,
                targetModel: options.targetModel,
                signals,
                references,
                lineDates,
                ...(facts ? { facts } : {}),
                destinations: targets,
              }),
            },
          ],
          deps.signal ? { signal: deps.signal } : {}
        )
        judged = parseJudgement(answer, redacted, destinationAliases(targets))
        judgedByModel = true
      } catch (error) {
        throwIfAborted(deps.signal)
        audited.skipped = "model-error"
        notes.push(
          `judge-failed:${surface.key}:${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    findings.push(
      ...surfaceFindings({
        surfaceKey: surface.key,
        judged,
        judgedByModel,
        signals,
        references,
        ...(document.skill ? { skill: document.skill } : {}),
      })
    )
    work.push({ surface, text, redacted, units, lineDates, audited })
  }

  // The conflict pass: only rules the model can see, from surfaces that load together.
  if (deps.llm) {
    throwIfAborted(deps.signal)
    deps.onProgress?.(done, total, "conflicts")
    const comparable: SurfaceUnits[] = work
      .filter((entry) => entry.redacted !== null && CONFLICT_SOURCES.has(entry.surface.source))
      .map((entry) => ({
        surfaceKey: entry.surface.key,
        units: instructionUnits(segmentRules(entry.redacted!)),
      }))
    const candidates = findOverlaps(comparable)
    if (candidates.length > 0) {
      const byKey = new Map(work.map((entry) => [entry.surface.key, entry]))
      const pairs = buildConflictPairs(candidates, (surfaceKey, startLine, endLine) => {
        const entry = byKey.get(surfaceKey)!
        const date = entry.lineDates.get(startLine)
        return {
          name: entry.surface.name,
          text: entry
            .redacted!.split("\n")
            .slice(startLine - 1, endLine)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
          ...(date ? { date } : {}),
        }
      })
      try {
        const answer = await deps.llm.complete(
          [
            { role: "system", content: await deps.resolvePrompt(PROMPT_IDS.conflicts) },
            { role: "user", content: buildConflictRequest(pairs) },
          ],
          deps.signal ? { signal: deps.signal } : {}
        )
        findings.push(...conflictFindings(parseConflictAnswer(answer, pairs)))
      } catch (error) {
        throwIfAborted(deps.signal)
        notes.push(`conflicts-failed:${error instanceof Error ? error.message : String(error)}`)
      }
    }
    done++
  }
  deps.onProgress?.(total, total, "")

  const ranked = rankFindings(findings)
  const surfaceTexts = new Map<string, HunkSurface>(
    work.map((entry) => [
      entry.surface.key,
      { text: entry.text, redacted: entry.redacted ?? entry.text },
    ])
  )
  const { hunks, withheld } = buildHunks(ranked, surfaceTexts)
  for (const entry of withheld) notes.push(`hunk-withheld:${entry.findingId}:${entry.reason}`)

  return {
    id: deps.newId(),
    workspaceId: options.workspaceId,
    startedAt,
    finishedAt: deps.now(),
    targetModel: options.targetModel,
    ...(deps.llm && options.judgeModel ? { judgeModel: options.judgeModel } : {}),
    surfaces: work.map((entry) => entry.audited),
    findings: ranked,
    hunks,
    failedSources: [...listing.failed],
    notes,
  }
}
