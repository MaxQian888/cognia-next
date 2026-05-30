/**
 * Shared helpers for the ultracode `pattern.*` node executors (ADR-0022
 * addendum). Each pattern reads the per-run TeamRunContext, fans out
 * tool-enabled teammate dispatches bounded by the run's ConcurrencyController,
 * and exchanges findings/verdicts through the workflow's upstream map.
 */

import type { StepExecutionContext } from "@/types/workflow/visual"
import { type Finding, findingKey } from "@/types/agent/ultracode"
import { getTeamRunContext, type TeamRunContext } from "../team-run-context"

/** Build an error the orchestrator must not retry. */
export function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

/** Resolve the per-run team context or throw a non-retryable error. */
export function getTeamCtxOrThrow(ctx: StepExecutionContext): TeamRunContext {
  const teamCtx = getTeamRunContext(ctx.runId)
  if (!teamCtx) {
    throw nonRetryable(
      `ultracode pattern node: no TeamRunContext registered for runId=${ctx.runId}`
    )
  }
  return teamCtx
}

/** Effective fan-out width — the run's live concurrency cap, never below 1. */
export function fanoutLimit(teamCtx: TeamRunContext): number {
  return Math.max(1, teamCtx.concurrency.get())
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Per-item rejections are
 * caught and surface as `null` (mirrors Claude Code's `.filter(Boolean)`), with
 * the error logged via `onError` so coverage drops are never silent.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onError?: (error: unknown, item: T, index: number) => void
): Promise<(R | null)[]> {
  const results = new Array<R | null>(items.length).fill(null)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i] as T, i)
      } catch (err) {
        results[i] = null
        onError?.(err, items[i] as T, i)
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

/** Generic upstream field collector: flattens `output[key]` arrays across nodes. */
export function collectUpstreamArray<T>(upstream: Record<string, unknown>, key: string): T[] {
  const out: T[] = []
  for (const value of Object.values(upstream)) {
    const arr = (value as Record<string, unknown> | null)?.[key]
    if (Array.isArray(arr)) out.push(...(arr as T[]))
  }
  return out
}

/** First upstream output that carries a non-empty `key`. */
export function firstUpstream<T>(upstream: Record<string, unknown>, key: string): T | undefined {
  for (const value of Object.values(upstream)) {
    const v = (value as Record<string, unknown> | null)?.[key]
    if (v !== undefined && v !== null) return v as T
  }
  return undefined
}

/** Collect every upstream finding, assigning ids and deduping by `findingKey`. */
export function collectFindings(upstream: Record<string, unknown>): Finding[] {
  return dedupeFindings(assignFindingIds(collectUpstreamArray<Finding>(upstream, "findings")))
}

/** Ensure every finding has a stable id (synthesized from its key when absent). */
export function assignFindingIds(findings: Finding[]): Finding[] {
  return findings.map((f, i) => (f.id ? f : { ...f, id: `f${i}_${findingKey(f).slice(0, 24)}` }))
}

/** Dedupe findings by `findingKey`, keeping first occurrence order. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const f of findings) {
    const k = findingKey(f)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

/** Compact one-line rendering of a finding for embedding in a prompt. */
export function renderFinding(f: Finding): string {
  const sev = f.severity ? `[${f.severity}] ` : ""
  const loc = f.location ? ` (${f.location})` : ""
  return `${sev}${f.title}${loc}: ${f.detail}`
}
