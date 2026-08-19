"use client"

/**
 * Chat-history discovery for the first-run scan step (ADR-0122 × ADR-0062).
 *
 * Onboarding already offered to bring over an agent's *configuration* through
 * the ADR-0107 migration wizard, and that wizard's `sessions` artifact quietly
 * carried the conversations too. Two things were wrong with leaving it there:
 *
 *  1. The wizard is keyed on `MIGRATION_VENDORS` — four vendors — while the
 *     session-import registry ships seven sources. Gemini CLI, Continue and
 *     Aider histories were unreachable from the flow entirely.
 *  2. It is keyed on a *config* probe. An agent whose config directory is
 *     absent (or relocated somewhere the probe does not look) was skipped even
 *     when its transcripts were sitting right there on disk.
 *
 * So history gets its own pass, over `scanAllSources()` — the same read the
 * Settings → Data importer uses, so a source is covered here the moment it
 * registers, including one contributed by a plugin.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"

import { getSessionSource } from "@/lib/session-import"
import { shellRunsMachineScan } from "@/lib/onboarding/scan"
import {
  useSessionImport,
  type UseSessionImportDeps,
} from "@/hooks/session-import/use-session-import"
import type { OnboardingShell } from "@cognia/agent-config-types"
import type { SessionSummary } from "@/lib/session-import"

/** One agent's importable history, for the step's per-source line. */
export interface HistorySourceCount {
  sourceId: string
  /** The adapter's own display name ("Claude Code", "Gemini CLI", …). */
  label: string
  sessions: number
}

const NO_SUMMARIES: readonly SessionSummary[] = []

export type HistoryImportPhase = "idle" | "scanning" | "found" | "empty" | "importing" | "done"

export interface HistoryImport {
  phase: HistoryImportPhase
  /** Conversations found across every source. */
  total: number
  /** Per-source breakdown, largest first. */
  sources: HistorySourceCount[]
  /** Conversations actually written, once `phase === "done"`. */
  imported: number
  /** 0…1 while importing; drives the inline progress label. */
  progress: number
  /** True when the scan finished but at least one source failed to be read. */
  partial: boolean
  /** Import everything found into `projectId` (the active workspace). */
  importAll: (projectId?: string) => Promise<void>
}

/** Group summaries by source, resolving each adapter's display name. */
export function summarizeHistory(summaries: readonly SessionSummary[]): HistorySourceCount[] {
  const bySource = new Map<string, number>()
  for (const summary of summaries) {
    bySource.set(summary.sourceId, (bySource.get(summary.sourceId) ?? 0) + 1)
  }
  return [...bySource.entries()]
    .map(([sourceId, sessions]) => ({
      sourceId,
      // Fall back to the raw id rather than dropping the row: a plugin source
      // that unregistered between scan and render still has real sessions.
      label: getSessionSource(sourceId)?.displayName ?? sourceId,
      sessions,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.sourceId.localeCompare(b.sourceId))
}

export interface UseHistoryImportOptions {
  shell: OnboardingShell
  /** Forwarded to the session-import state machine — the tests' seam. */
  deps?: UseSessionImportDeps
}

export function useHistoryImport({ shell, deps }: UseHistoryImportOptions): HistoryImport {
  const { state, scan, importSelected } = useSessionImport(deps)
  const runs = shellRunsMachineScan(shell)
  const scanned = useRef(false)

  useEffect(() => {
    // Only the desktop has agent trees to walk, and only once per mount — the
    // scan reads every source's directory and re-running it on each render
    // would make the step crawl.
    if (!runs || scanned.current) return
    scanned.current = true
    void scan()
  }, [runs, scan])

  // Shared empty array, not a fresh `[]` per render: this value seeds a
  // `useMemo` whose result is handed to the step as a prop, and a new identity
  // on every render propagates outward. That is precisely how the ⌘K search
  // loop happened (`lib/tray/state-snapshot.ts`), so it is not worth repeating
  // one layer down.
  const summaries = useMemo(
    () => (state.status === "list" ? state.summaries : NO_SUMMARIES),
    [state]
  )
  const sources = useMemo(() => summarizeHistory(summaries), [summaries])

  const importAll = useCallback(
    async (projectId?: string) => {
      await importSelected(projectId)
    },
    [importSelected]
  )

  const phase: HistoryImportPhase =
    state.status === "scanning"
      ? "scanning"
      : state.status === "importing"
        ? "importing"
        : state.status === "done"
          ? "done"
          : state.status === "list"
            ? summaries.length > 0
              ? "found"
              : "empty"
            : // `error` collapses into `empty`: a first-run user cannot act on
              // "the OpenCode database could not be read", and the step must
              // never block the path to a first output.
              state.status === "error"
              ? "empty"
              : "idle"

  const imported = state.status === "done" ? state.sessionsAdded : 0
  const progress =
    state.status === "importing" && state.total > 0
      ? Math.min(1, state.done / state.total)
      : phase === "done"
        ? 1
        : 0
  const partial = state.status === "list" && (state.warnings?.length ?? 0) > 0

  return useMemo(
    () => ({ phase, total: summaries.length, sources, imported, progress, partial, importAll }),
    [phase, summaries, sources, imported, progress, partial, importAll]
  )
}
