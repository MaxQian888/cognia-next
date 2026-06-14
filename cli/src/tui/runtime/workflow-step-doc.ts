/**
 * Pure markdown builder for the single-step inspector overlay (Ctrl+I on a live
 * `/workflow run`). Surfaces a step's status, usage, output, input, and logs from
 * the raw run events — reusing `aggregateRunUsage` for the per-step token/cost
 * breakdown so the figures match the desktop Runs panel. No Dexie, no Ink.
 */
import type { WorkflowRunEventRow } from "@/types/workflow/visual"
import { aggregateRunUsage } from "@/lib/workflow/runs/usage-aggregate"

import { formatRunDuration } from "./workflow-doc"
import { stepStatusIcon, type RunStepView } from "./workflow-run-fold"
import { formatTokens, formatCost } from "../format/usage"

const OUTPUT_MAX = 1200
const MAX_LOGS = 20

function pretty(value: unknown): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    if (!s) return ""
    return s.length > OUTPUT_MAX ? s.slice(0, OUTPUT_MAX) + "\n… (truncated)" : s
  } catch {
    return String(value)
  }
}

function logLevel(e: WorkflowRunEventRow): string {
  return e.level ? e.level.toUpperCase() : "INFO"
}

function logText(e: WorkflowRunEventRow): string | undefined {
  const p = e.payload as { message?: unknown } | undefined
  if (p && typeof p.message === "string") return p.message
  return undefined
}

/** Build the inspector markdown for `step` from the run's raw `events`. */
export function buildStepInspectorDoc(step: RunStepView, events: WorkflowRunEventRow[]): string {
  const lines: string[] = [`# ${stepStatusIcon(step.status)} ${step.label}`, ""]

  const meta: string[] = [`**Status:** ${step.status}`]
  if (step.category) meta.push(`**Category:** ${step.category}`)
  if (step.durationMs !== undefined)
    meta.push(`**Duration:** ${formatRunDuration(step.durationMs)}`)
  if (step.iterations && step.iterations > 1) meta.push(`**Iterations:** ${step.iterations}`)
  if (step.retryCount) meta.push(`**Retries:** ${step.retryCount}`)
  lines.push(meta.join(" · "), "")

  if (step.error) lines.push(`> ⚠️ ${step.error}`, "")

  // ── Usage ──────────────────────────────────────────────────────────────────
  const usage = aggregateRunUsage(events).perStep[step.id]
  lines.push("## Usage")
  if (usage) {
    const parts = [
      `${formatTokens(usage.totalTokens)} tokens`,
      `in ${formatTokens(usage.inputTokens)} · out ${formatTokens(usage.outputTokens)}`,
    ]
    if (usage.cacheReadTokens) parts.push(`cache-read ${formatTokens(usage.cacheReadTokens)}`)
    if (usage.cacheCreationTokens)
      parts.push(`cache-write ${formatTokens(usage.cacheCreationTokens)}`)
    if (usage.modelId) parts.push(`model ${usage.modelId}`)
    if (typeof usage.costUsd === "number") parts.push(formatCost(usage.costUsd))
    lines.push(parts.join(" · "))
  } else {
    lines.push("_none_")
  }
  lines.push("")

  // ── Output ─────────────────────────────────────────────────────────────────
  const completed = [...events]
    .reverse()
    .find((e) => e.type === "step_completed" && e.stepId === step.id)
  lines.push("## Output")
  lines.push(completed ? "```\n" + pretty(completed.payload) + "\n```" : "_none_")
  lines.push("")

  // ── Input ──────────────────────────────────────────────────────────────────
  const started = events.find((e) => e.type === "step_started" && e.stepId === step.id)
  lines.push("## Input")
  lines.push(started?.payload ? "```\n" + pretty(started.payload) + "\n```" : "_none_")
  lines.push("")

  // ── Logs ───────────────────────────────────────────────────────────────────
  const logs = events
    .filter((e) => e.type === "run_log" && e.stepId === step.id)
    .map((e) => ({ level: logLevel(e), text: logText(e) }))
    .filter((l): l is { level: string; text: string } => Boolean(l.text))
  lines.push("## Logs")
  if (logs.length === 0) {
    lines.push("_none_")
  } else {
    for (const l of logs.slice(-MAX_LOGS)) lines.push(`- [${l.level}] ${l.text}`)
  }

  return lines.join("\n")
}
