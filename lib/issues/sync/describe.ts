/**
 * What "Sync now" should say when it finishes. Pure, so both consoles and a
 * future RPC print the same sentence from the same result.
 */

import { isMissingGithubCredential } from "@/lib/issues/sync-runner"
import type { RunWorkspaceIssueSyncResult } from "./runner"

export type SyncSummaryPart =
  "imported" | "updated" | "pushed" | "conflicts" | "queued" | "linked" | "written"

export type SyncSummary =
  | { kind: "no-bindings" }
  | { kind: "no-credential" }
  | { kind: "failed"; names: string[]; parts: Array<{ part: SyncSummaryPart; count: number }> }
  | { kind: "up-to-date" }
  | { kind: "changed"; parts: Array<{ part: SyncSummaryPart; count: number }> }

/** Non-zero counts, in a fixed reading order. */
export function summarizeSyncParts(
  result: RunWorkspaceIssueSyncResult
): Array<{ part: SyncSummaryPart; count: number }> {
  const sum = (pick: (o: RunWorkspaceIssueSyncResult["outcomes"][number]) => number) =>
    result.outcomes.reduce((total, outcome) => total + pick(outcome), 0)
  const counts: Array<{ part: SyncSummaryPart; count: number }> = [
    { part: "imported", count: sum((o) => o.created) },
    { part: "updated", count: sum((o) => o.updated) },
    { part: "pushed", count: sum((o) => o.pushed) },
    { part: "conflicts", count: sum((o) => o.conflicts) },
    { part: "queued", count: sum((o) => o.queued) },
    { part: "linked", count: sum((o) => o.linked) },
    { part: "written", count: result.mirror.results.reduce((t, r) => t + r.written, 0) },
  ]
  return counts.filter((entry) => entry.count > 0)
}

export function summarizeSync(result: RunWorkspaceIssueSyncResult): SyncSummary {
  if (result.bindingCount === 0) return { kind: "no-bindings" }
  const failures = [
    ...result.mirror.failures.map((f) => ({ name: f.repoFullName, error: f.error })),
    ...result.failures.map((f) => ({ name: f.binding.key, error: f.error })),
  ]
  const parts = summarizeSyncParts(result)
  if (failures.length > 0) {
    if (failures.every((failure) => isMissingGithubCredential(failure.error))) {
      return { kind: "no-credential" }
    }
    return { kind: "failed", names: failures.map((failure) => failure.name), parts }
  }
  return parts.length === 0 ? { kind: "up-to-date" } : { kind: "changed", parts }
}

/** `useTranslations("issues")`'s shape, narrowed to what the message needs. */
export type SyncTranslate = (key: string, values?: Record<string, string | number>) => string

/** The toast for a summary: which level, and the localized sentence. */
export function syncSummaryMessage(
  summary: SyncSummary,
  t: SyncTranslate
): { level: "success" | "info" | "error"; message: string } {
  const list = (parts: Array<{ part: SyncSummaryPart; count: number }>) =>
    parts
      .map((entry) => t(`sync.parts.${entry.part}`, { count: entry.count }))
      .join(t("sync.joiner"))
  switch (summary.kind) {
    case "no-bindings":
      return { level: "info", message: t("sync.noBindings") }
    case "no-credential":
      return { level: "error", message: t("sync.noCredential") }
    case "up-to-date":
      return { level: "success", message: t("sync.upToDate") }
    case "changed":
      return { level: "success", message: list(summary.parts) }
    case "failed":
      return {
        level: "error",
        message: t("sync.failedBindings", { names: summary.names.join(", ") }),
      }
  }
}
