/**
 * Deep session analysis — a single-pass health report over one chat session's
 * messages + per-turn usage rows. Ported (algorithm, not code) from an external
 * agent-orchestration app's session analyzer and adapted to cognia's data model:
 *
 *  • token / cost / per-model stats reuse {@link aggregateByModel} +
 *    {@link effectiveCostUsd} (no duplicated pricing math);
 *  • behavioural signals (friction, thrashing, thinking, tests) come from
 *    {@link import("./session-signals")};
 *  • context pressure reuses {@link getModelContextWindow}.
 *
 * The analyzer returns stable reasoning *ids + params* (never English) so the
 * renderer can localise via next-intl. Pure + clock-injectable for tests.
 */

import type { UIMessage } from "ai"

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { getModelContextWindow } from "@/lib/claude/usage"
import {
  aggregateByModel,
  effectiveCostUsd,
  type ModelUsageRow,
  type PricingResolver,
} from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"
import {
  BASH_THRASH_THRESHOLD,
  FILE_EDIT_THRASH_THRESHOLD,
  bashCommandPrefix,
  detectFriction,
  detectThinkingSignals,
  isGitCommit,
  parseTestSummary,
} from "@/lib/analysis/session-signals"

export type AssessmentLevel = "critical" | "warning" | "info" | "healthy"

export type AssessmentId =
  | "cacheEfficiency"
  | "toolHealth"
  | "thrashing"
  | "redundancy"
  | "costPerCommit"
  | "overhead"
  | "context"

/** One scored health dimension. `reasoningKey` = `<id>.<level>` for i18n lookup. */
export interface Assessment {
  id: AssessmentId
  /** 0 (worst) .. 1 (best). */
  score: number
  level: AssessmentLevel
  reasoningKey: string
  params?: Record<string, number | string>
}

/** A course-correction phrase found in a user message. */
export interface FrictionSignal {
  messageIndex: number
  signals: string[]
}

/** A parsed test-runner result snapshot. */
export interface TestSnapshot {
  messageIndex: number
  passed: number
  failed: number
}

/** A silent stretch (> threshold) between consecutive billed turns. */
export interface IdleGap {
  fromAt: number
  toAt: number
  seconds: number
}

/** A model change between consecutive billed turns. */
export interface ModelSwitch {
  from: string
  to: string
}

export interface SessionReport {
  title?: string
  /** Wall-clock span of billed turns, in seconds (0 when < 2 turns). */
  durationSeconds: number
  turns: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
  models: ModelUsageRow[]
  /** Tool name → call count. */
  toolCounts: Record<string, number>
  toolCallTotal: number
  errorCount: number
  denialCount: number
  thinkingCount: number
  thinkingSignals: Record<string, number>
  friction: FrictionSignal[]
  frictionTotal: number
  testSnapshots: TestSnapshot[]
  idleGaps: IdleGap[]
  modelSwitches: ModelSwitch[]
  commitCount: number
  /** Linear message chain (cognia doesn't persist uuid/parent — see degraded). */
  conversationChain: string[]
  /** True when the tree was flattened to a linear chain (always, today). */
  degraded: boolean
  assessments: Assessment[]
}

interface AnalyzeInput {
  messages: UIMessage[]
  usageRows: SessionUsageRow[]
  sessionMeta?: { title?: string }
}

interface AnalyzeOpts {
  resolve?: PricingResolver
  idleThresholdSec?: number
}

const WORK_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep"])
const DEFAULT_IDLE_THRESHOLD_SEC = 60

type AnyPart = {
  type?: string
  state?: string
  text?: string
  input?: { command?: string; file_path?: string } & Record<string, unknown>
  output?: string
  variant?: string
  outcome?: string
}

function partsOf(message: UIMessage): AnyPart[] {
  return (message.parts ?? []) as unknown as AnyPart[]
}

function textOf(message: UIMessage): string {
  return partsOf(message)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
}

/** Strip the `tool-` prefix off a tool part type. */
function toolNameOf(part: AnyPart): string | null {
  if (!part.type || !part.type.startsWith("tool-")) return null
  return part.type.slice("tool-".length)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map)
}

/** Analyze one session into a localisable health report. */
export function analyzeSession(input: AnalyzeInput, opts: AnalyzeOpts = {}): SessionReport {
  const { messages, usageRows, sessionMeta } = input
  const resolve = opts.resolve ?? resolveModelPricingUsd
  const idleThreshold = opts.idleThresholdSec ?? DEFAULT_IDLE_THRESHOLD_SEC

  // ── Single pass over messages ──────────────────────────────────────────────
  const toolCounts = new Map<string, number>()
  const thinkingSignals = new Map<string, number>()
  const bashPrefixes = new Map<string, number>()
  const fileEdits = new Map<string, number>()
  const toolCallSignatures = new Map<string, number>()
  const friction: FrictionSignal[] = []
  const testSnapshots: TestSnapshot[] = []
  const conversationChain: string[] = []
  let errorCount = 0
  let denialCount = 0
  let thinkingCount = 0
  let toolCallTotal = 0
  let commitCount = 0
  let firstWorkToolIndex = -1
  let assistantTurnsBeforeFirstWorkTool = 0

  messages.forEach((message, index) => {
    conversationChain.push(message.id)
    const role = message.role

    if (role === "user") {
      const sig = detectFriction(textOf(message))
      if (sig.length > 0) friction.push({ messageIndex: index, signals: sig })
      return
    }

    if (role === "system") {
      for (const part of partsOf(message)) {
        if (part.type === "session-notice" && part.variant === "permission-denied") denialCount += 1
        if (part.type === "hook-notice" && part.outcome === "blocked") denialCount += 1
      }
      return
    }

    if (role !== "assistant") return

    for (const part of partsOf(message)) {
      if (part.type === "reasoning") {
        thinkingCount += 1
        for (const s of detectThinkingSignals(part.text ?? "")) bump(thinkingSignals, s)
        continue
      }

      const tool = toolNameOf(part)
      if (!tool) continue
      bump(toolCounts, tool)
      toolCallTotal += 1

      if (WORK_TOOLS.has(tool) && firstWorkToolIndex === -1) {
        firstWorkToolIndex = index
      }

      // Redundancy: identical (tool + input) invocations.
      const signature = `${tool}:${JSON.stringify(part.input ?? {})}`
      bump(toolCallSignatures, signature)

      if (part.state === "output-error") errorCount += 1

      const command = part.input?.command
      if (typeof command === "string") {
        const prefix = bashCommandPrefix(command)
        if (prefix) bump(bashPrefixes, prefix)
        if (isGitCommit(command)) commitCount += 1
      }

      const filePath = part.input?.file_path
      if (
        typeof filePath === "string" &&
        (tool === "Edit" || tool === "Write" || tool === "MultiEdit")
      ) {
        bump(fileEdits, filePath)
      }

      const out = part.output
      if (typeof out === "string") {
        const snap = parseTestSummary(out)
        if (snap) testSnapshots.push({ messageIndex: index, ...snap })
      }
    }
  })

  // Assistant turns before the first work tool (startup overhead proxy).
  if (firstWorkToolIndex >= 0) {
    assistantTurnsBeforeFirstWorkTool = messages
      .slice(0, firstWorkToolIndex)
      .filter((m) => m.role === "assistant").length
  }

  // ── Usage-row derived metrics (authoritative tokens/cost/timeline) ──────────
  const ordered = [...usageRows].sort((a, b) => a.at - b.at)
  const models = aggregateByModel(ordered, resolve)
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let totalCostUsd = 0
  let maxContextFraction = 0
  const idleGaps: IdleGap[] = []
  const modelSwitches: ModelSwitch[] = []
  let prevAt: number | null = null
  let prevModel: string | null = null

  for (const row of ordered) {
    totalInputTokens += row.inputTokens
    totalOutputTokens += row.outputTokens
    totalCacheReadTokens += row.cacheReadTokens
    totalCacheCreationTokens += row.cacheCreationTokens
    totalCostUsd += effectiveCostUsd(row, resolve)

    const prompt = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens
    const window = getModelContextWindow(row.model)
    if (window > 0) maxContextFraction = Math.max(maxContextFraction, prompt / window)

    if (prevAt !== null) {
      const seconds = (row.at - prevAt) / 1000
      if (seconds > idleThreshold) idleGaps.push({ fromAt: prevAt, toAt: row.at, seconds })
    }
    if (prevModel !== null && row.model && row.model !== prevModel) {
      modelSwitches.push({ from: prevModel, to: row.model })
    }
    prevAt = row.at
    if (row.model) prevModel = row.model
  }

  const turns = ordered.length
  const durationSeconds = turns >= 2 ? (ordered[turns - 1].at - ordered[0].at) / 1000 : 0
  const frictionTotal = friction.reduce((acc, f) => acc + f.signals.length, 0)

  const assessments = buildAssessments({
    cacheRead: totalCacheReadTokens,
    cacheCreation: totalCacheCreationTokens,
    toolCallTotal,
    errorCount,
    bashPrefixes,
    fileEdits,
    toolCallSignatures,
    totalCostUsd,
    commitCount,
    assistantTurnsBeforeFirstWorkTool,
    turns,
    maxContextFraction,
  })

  return {
    title: sessionMeta?.title,
    durationSeconds,
    turns,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalCostUsd,
    models,
    toolCounts: toRecord(toolCounts),
    toolCallTotal,
    errorCount,
    denialCount,
    thinkingCount,
    thinkingSignals: toRecord(thinkingSignals),
    friction,
    frictionTotal,
    testSnapshots,
    idleGaps,
    modelSwitches,
    commitCount,
    conversationChain,
    degraded: true,
    assessments,
  }
}

interface AssessmentInputs {
  cacheRead: number
  cacheCreation: number
  toolCallTotal: number
  errorCount: number
  bashPrefixes: Map<string, number>
  fileEdits: Map<string, number>
  toolCallSignatures: Map<string, number>
  totalCostUsd: number
  commitCount: number
  assistantTurnsBeforeFirstWorkTool: number
  turns: number
  maxContextFraction: number
}

function mk(
  id: AssessmentId,
  score: number,
  level: AssessmentLevel,
  params?: Record<string, number | string>
): Assessment {
  return { id, score: clamp01(score), level, reasoningKey: `${id}.${level}`, params }
}

/** Compute the seven scored health dimensions. Pure. */
export function buildAssessments(i: AssessmentInputs): Assessment[] {
  const out: Assessment[] = []

  // Cache efficiency — read vs creation ratio.
  if (i.cacheCreation === 0) {
    out.push(mk("cacheEfficiency", 1, "info"))
  } else {
    const ratio = i.cacheRead / i.cacheCreation
    if (ratio < 0.5) out.push(mk("cacheEfficiency", 0.3, "warning", { ratio: round1(ratio) }))
    else if (ratio >= 2) out.push(mk("cacheEfficiency", 0.9, "healthy", { ratio: round1(ratio) }))
    else out.push(mk("cacheEfficiency", 0.6, "info", { ratio: round1(ratio) }))
  }

  // Tool health — error rate over tool calls.
  if (i.toolCallTotal === 0) {
    out.push(mk("toolHealth", 1, "info"))
  } else {
    const rate = i.errorCount / i.toolCallTotal
    const pct = Math.round(rate * 100)
    if (rate > 0.25) out.push(mk("toolHealth", 0.2, "critical", { pct, errors: i.errorCount }))
    else if (rate > 0.1) out.push(mk("toolHealth", 0.5, "warning", { pct, errors: i.errorCount }))
    else out.push(mk("toolHealth", 0.95, "healthy", { pct, errors: i.errorCount }))
  }

  // Thrashing — repeated Bash prefixes + repeated file edits.
  let thrash = 0
  for (const c of i.bashPrefixes.values())
    if (c >= BASH_THRASH_THRESHOLD) thrash += c - (BASH_THRASH_THRESHOLD - 1)
  for (const c of i.fileEdits.values())
    if (c >= FILE_EDIT_THRASH_THRESHOLD) thrash += c - (FILE_EDIT_THRASH_THRESHOLD - 1)
  if (thrash > 10) out.push(mk("thrashing", 0.2, "warning", { events: thrash }))
  else if (thrash > 3) out.push(mk("thrashing", 0.5, "info", { events: thrash }))
  else out.push(mk("thrashing", 0.9, "healthy", { events: thrash }))

  // Redundancy — duplicate identical tool calls.
  let duplicates = 0
  for (const c of i.toolCallSignatures.values()) if (c > 1) duplicates += c - 1
  const dupRate = i.toolCallTotal > 0 ? duplicates / i.toolCallTotal : 0
  if (dupRate > 0.3) out.push(mk("redundancy", 0.3, "warning", { duplicates }))
  else if (dupRate > 0.1) out.push(mk("redundancy", 0.6, "info", { duplicates }))
  else out.push(mk("redundancy", 0.9, "healthy", { duplicates }))

  // Cost per commit — only meaningful when commits happened.
  if (i.commitCount === 0) {
    out.push(mk("costPerCommit", 1, "info"))
  } else {
    const perCommit = i.totalCostUsd / i.commitCount
    const cents = Math.round(perCommit * 100)
    if (perCommit > 2)
      out.push(
        mk("costPerCommit", 0.3, "warning", { cost: round2(perCommit), commits: i.commitCount })
      )
    else
      out.push(
        mk("costPerCommit", 0.85, "healthy", {
          cost: round2(perCommit),
          commits: i.commitCount,
          cents,
        })
      )
  }

  // Overhead — assistant turns spent before the first real work tool.
  const overheadTurns = i.assistantTurnsBeforeFirstWorkTool
  if (overheadTurns >= 4) out.push(mk("overhead", 0.4, "warning", { turns: overheadTurns }))
  else if (overheadTurns >= 2) out.push(mk("overhead", 0.7, "info", { turns: overheadTurns }))
  else out.push(mk("overhead", 0.95, "healthy", { turns: overheadTurns }))

  // Context pressure — peak prompt fill across the session.
  const pct = Math.round(clamp01(i.maxContextFraction) * 100)
  if (i.maxContextFraction >= 0.835) out.push(mk("context", 0.3, "critical", { pct }))
  else if (i.maxContextFraction >= 0.6) out.push(mk("context", 0.6, "warning", { pct }))
  else out.push(mk("context", 0.95, "healthy", { pct }))

  return out
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
