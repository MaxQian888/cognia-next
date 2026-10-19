"use client"

/**
 * Live views of Harness Evolution's tables (ADR-0237): runs, their steps and
 * snapshots, the experience library, and a run's spend as its usage rows
 * land. Every hook re-renders when the rows change, so a run viewer follows a
 * run as the driver writes it.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  getHarnessRun,
  getHarnessSnapshots,
  listHarnessExperiences,
  listHarnessRuns,
  listHarnessSnapshots,
  listHarnessSteps,
} from "@/lib/db/harness-evolution"
import { listUsageForSession } from "@/lib/db/session-usage"
import { ledgerFromUsage, runUsageSessionId } from "@/lib/harness/ledger"
import { planRun } from "@/lib/harness/recursion"
import { harnessEvolutionSettingsOf, type HarnessEvolutionSettings } from "@/lib/harness/settings"
import { useSettingsStore } from "@/stores/settings"
import type {
  HarnessBudgetLedger,
  HarnessEvolutionRun,
  HarnessEvolutionStep,
} from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"

const NO_STEPS: HarnessEvolutionStep[] = []
const NO_EXPERIENCES: HarnessExperience[] = []
const NO_SNAPSHOTS: HarnessSnapshotV1[] = []
const NO_SNAPSHOT_MAP = new Map<string, HarnessSnapshotV1>()

/** The settings, normalised. */
export function useHarnessEvolutionSettings(): HarnessEvolutionSettings {
  const stored = useSettingsStore((s) => s.settings?.harnessEvolution)
  return useMemo(() => harnessEvolutionSettingsOf({ harnessEvolution: stored }), [stored])
}

/** Runs of one agent (or every agent), newest first. `undefined` while loading. */
export function useHarnessRuns(
  characterId?: string,
  limit = 100
): HarnessEvolutionRun[] | undefined {
  return useLiveQuery(
    () => listHarnessRuns({ ...(characterId ? { characterId } : {}), limit }),
    [characterId, limit]
  )
}

export function useHarnessRun(runId: string | undefined): HarnessEvolutionRun | null | undefined {
  return useLiveQuery(async () => (runId ? ((await getHarnessRun(runId)) ?? null) : null), [runId])
}

export function useHarnessSteps(runId: string | undefined): HarnessEvolutionStep[] {
  return useLiveQuery(
    () => (runId ? listHarnessSteps(runId) : Promise.resolve(NO_STEPS)),
    [runId],
    NO_STEPS
  )
}

/** Snapshots by id, for the harnesses a run's steps produced. */
export function useHarnessSnapshots(ids: readonly string[]): Map<string, HarnessSnapshotV1> {
  const key = [...new Set(ids)].sort().join(",")
  return useLiveQuery(
    () => (key ? getHarnessSnapshots(key.split(",")) : Promise.resolve(NO_SNAPSHOT_MAP)),
    [key],
    NO_SNAPSHOT_MAP
  )
}

/** An agent's version history, newest first. */
export function useAgentHarnessSnapshots(characterId: string | undefined): HarnessSnapshotV1[] {
  return useLiveQuery(
    () => (characterId ? listHarnessSnapshots(characterId) : Promise.resolve(NO_SNAPSHOTS)),
    [characterId],
    NO_SNAPSHOTS
  )
}

export function useHarnessExperiences(options: {
  characterId?: string
  includeDisabled?: boolean
}): HarnessExperience[] {
  const { characterId, includeDisabled = true } = options
  return useLiveQuery(
    () => listHarnessExperiences({ ...(characterId ? { characterId } : {}), includeDisabled }),
    [characterId, includeDisabled],
    NO_EXPERIENCES
  )
}

/**
 * The run's spend as of its latest usage row, live. Rollouts and model calls
 * book their usage when they end, so this moves while the run works, ahead of
 * the ledger the driver stores between waves.
 */
export function useHarnessLiveLedger(
  run: HarnessEvolutionRun | null | undefined,
  steps: readonly HarnessEvolutionStep[]
): HarnessBudgetLedger | undefined {
  const runId = run?.id
  const rows = useLiveQuery(
    () => (runId ? listUsageForSession(runUsageSessionId(runId)) : Promise.resolve([])),
    [runId]
  )
  return useMemo(() => {
    if (!run || !rows) return run?.ledger
    const kinds = new Map(planRun(run.config.mode, run.config.k).map((s) => [s.label, s.kind]))
    const finished = steps.filter((s) => s.status === "succeeded")
    return ledgerFromUsage({
      rows,
      runId: run.id,
      kindOf: (label) => kinds.get(label),
      finishedRollouts: finished.filter((s) => s.kind === "rollout" && !s.cacheHitOf).length,
      finishedSessions: finished.filter((s) => s.kind !== "rollout").length,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    })
  }, [run, rows, steps])
}
