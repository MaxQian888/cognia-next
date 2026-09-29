/**
 * App-side runner for memory lint (`@cognia/memory/lint/memory-lint`): loads
 * the active rows and the user's retention knobs, reads stored vectors for the
 * durable rows when a compliant vector backend exists (for the suspected-
 * contradiction check), and returns the findings. Report-only — it writes
 * nothing, embeds nothing and calls no model.
 */

import { getSettings } from "@/lib/db/settings"
import { listMemories } from "@/lib/db/memories"
import { resolveMemoryConfig, type Memory } from "@/types/memory/memory"
import {
  CONTRADICTION_MAX_MEMORIES,
  lintMemories,
  type MemoryLintFinding,
} from "@cognia/memory/lint/memory-lint"
import { retentionParamsFor } from "@/lib/memory/lifecycle/lifecycle-sweep"

export interface MemoryLintReport {
  findings: MemoryLintFinding[]
  /** Whether the vector-based contradiction check could run. */
  contradictionCheck: "ran" | "no_vectors" | "disabled"
  /** Rows linted. */
  scanned: number
}

export async function runMemoryLint(
  options: { memories?: readonly Memory[]; now?: number } = {}
): Promise<MemoryLintReport> {
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  const memories = options.memories ?? (await listMemories({ status: "active" }))
  const active = memories.filter((memory) => memory.status === "active" && !memory.revisionOf)

  let embeddings: Map<string, number[]> | undefined
  let contradictionCheck: MemoryLintReport["contradictionCheck"] = "disabled"
  if (config.enabled && !config.temporary) {
    const durable = active
      .filter((memory) => memory.type === "semantic" || memory.type === "procedural")
      // Same coldest-first cut the detector applies, so no vector is read for
      // a row the detector would drop anyway.
      .sort((a, b) => a.accessCount - b.accessCount || a.updatedAt - b.updatedAt)
      .slice(0, CONTRADICTION_MAX_MEMORIES)
    const { tryBuildMemoryVectorReader } = await import("@/lib/memory/runtime/build-deps")
    const reader = await tryBuildMemoryVectorReader(config)
    if (reader && durable.length > 1) {
      embeddings = await reader.getEmbeddings(durable).catch(() => undefined)
    }
    contradictionCheck = embeddings && embeddings.size > 1 ? "ran" : "no_vectors"
  }

  return {
    findings: lintMemories(active, {
      now: options.now,
      retention: retentionParamsFor(config),
      coldThreshold: config.coldRetentionThreshold,
      ...(embeddings ? { embeddings } : {}),
    }),
    contradictionCheck,
    scanned: active.length,
  }
}
