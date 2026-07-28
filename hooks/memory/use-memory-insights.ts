"use client"

/**
 * Everything the Settings → Memory pane reads but never writes: corpus counts,
 * vector coverage, job-queue health, recent maintenance, and — most importantly
 * — what recall is *actually* doing right now.
 *
 * Table-backed numbers go through `useLiveQuery` so they self-heal after the
 * shared Dexie instance is reopened mid-boot. The retrieval-mode probe is the
 * one non-Dexie read (it inspects the embedding backend), so it is a guarded
 * one-shot with an explicit refresh instead.
 */

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { listMemories } from "@/lib/db/memories"
import {
  findEarliestInstrumentedAuditAt,
  listMemoryAuditEventsSince,
  listMemoryJobs,
} from "@/lib/db/memory-governance"
import {
  computeMemoryCorpusInsights,
  summarizeMemoryJobs,
  summarizeMemoryMaintenance,
  INSTRUMENTED_MAINTENANCE_REASONS,
  type MemoryCorpusInsights,
  type MemoryJobKindSummary,
  type MemoryMaintenanceSummary,
} from "@/lib/memory/insights"
import {
  describeMemoryRetrievalMode,
  type MemoryRetrievalMode,
} from "@/lib/memory/runtime/build-deps"
import type { MemoryConfig } from "@/types/memory/memory"

const DAY_MS = 24 * 60 * 60 * 1000
export const MAINTENANCE_WINDOW_DAYS = 7

const EMPTY_CORPUS: MemoryCorpusInsights = {
  stats: {
    total: 0,
    active: 0,
    pinned: 0,
    conflicts: 0,
    byType: { semantic: 0, episodic: 0, procedural: 0 },
  },
  byScope: { global: 0, workspace: 0, character: 0, agent: 0 },
  vector: { embedded: 0, active: 0, coverage: 0 },
  averageTokens: 0,
}

export interface MemoryInsights {
  corpus: MemoryCorpusInsights
  jobs: MemoryJobKindSummary[]
  maintenance: MemoryMaintenanceSummary | undefined
  /** Start of the maintenance window the summary covers. */
  maintenanceWindowStart: number
  /** `undefined` while the probe is in flight. */
  retrievalMode: MemoryRetrievalMode | undefined
  /** True until the corpus query has produced its first result. */
  loading: boolean
  refreshRetrievalMode: () => void
}

/**
 * The retrieval probe depends on exactly these config fields. Keying the effect
 * on a derived string rather than the whole object keeps a settings save that
 * only touched, say, `retrievalTopK` from re-probing the vector backend.
 */
function retrievalProbeKey(config: MemoryConfig): string {
  return [config.enabled, config.temporary, config.hybridEnabled, config.allowCloudEmbedding].join(
    "|"
  )
}

export function useMemoryInsights(config: MemoryConfig): MemoryInsights {
  // Pinned once: a moving window would resubscribe the audit query on every render.
  const [windowStart] = useState(() => Date.now() - MAINTENANCE_WINDOW_DAYS * DAY_MS)
  const [retrievalMode, setRetrievalMode] = useState<MemoryRetrievalMode | undefined>(undefined)
  const [probeNonce, setProbeNonce] = useState(0)

  const memories = useLiveQuery(() => listMemories(), [])
  const jobRows = useLiveQuery(() => listMemoryJobs(), [])
  const auditRows = useLiveQuery(() => listMemoryAuditEventsSince(windowStart), [windowStart])
  // Boxed: `findEarliestInstrumentedAuditAt` legitimately resolves to
  // `undefined` ("never instrumented"), which useLiveQuery cannot tell apart
  // from "still loading". Unboxed, a user with exact data would flash the
  // "estimated" caption on every mount.
  const preciseSinceBox = useLiveQuery(
    () =>
      findEarliestInstrumentedAuditAt(INSTRUMENTED_MAINTENANCE_REASONS).then((value) => ({
        value,
      })),
    []
  )

  const probeKey = retrievalProbeKey(config)
  useEffect(() => {
    let cancelled = false
    void describeMemoryRetrievalMode(config)
      .then((mode) => {
        if (!cancelled) setRetrievalMode(mode)
      })
      // The probe already swallows backend failures; this only catches a
      // caller-side explosion, which must not blank the whole pane.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // `config` is intentionally not a dependency — only the fields the probe
    // actually reads are, via `probeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey, probeNonce])

  const refreshRetrievalMode = useCallback(() => setProbeNonce((n) => n + 1), [])

  const corpus = memories ? computeMemoryCorpusInsights(memories) : EMPTY_CORPUS
  const jobs = summarizeMemoryJobs(jobRows ?? [])
  const maintenance =
    memories && auditRows && preciseSinceBox
      ? summarizeMemoryMaintenance({
          events: auditRows,
          memories,
          windowStart,
          preciseSince: preciseSinceBox.value,
        })
      : undefined

  return {
    corpus,
    jobs,
    maintenance,
    maintenanceWindowStart: windowStart,
    retrievalMode,
    loading: memories === undefined,
    refreshRetrievalMode,
  }
}
