"use client"

/**
 * Collects the directories the app is already working in, so the switcher can
 * offer to adopt the ones no workspace owns.
 *
 * The impure half of `lib/workspace/adopt-candidates`: it knows where the
 * signals live, that module knows what to do with them. Every source is
 * optional and failure-tolerant — this is a suggestion surface, and a
 * registry that is unreachable (browser shell, host offline) should cost the
 * suggestion, never the switcher.
 *
 * Sources report the *repository*, not a derived checkout. A managed worktree
 * contributes its `sourceRoot`; adopting the worktree path itself would create
 * the duplicate entity adoption exists to remove.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  buildAdoptionCandidates,
  dismissAdoption,
  readDismissedAdoptions,
  type AdoptionCandidate,
  type AdoptionSighting,
} from "@/lib/workspace/adopt-candidates"
import { listWorkspaceEnvironments } from "@/lib/task-workspace/client"
import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export interface UseAdoptionCandidatesResult {
  candidates: AdoptionCandidate[]
  /** False only until the first collection settles. */
  ready: boolean
  /** Hide one path on this device and drop it from the list. */
  dismiss: (path: string) => void
  /** Re-collect, e.g. after adopting one. */
  refresh: () => void
}

/** Sightings from the managed-workspace registry. Empty when it is unreachable. */
async function collectRegistrySightings(): Promise<AdoptionSighting[]> {
  try {
    const rows = await listWorkspaceEnvironments()
    const out: AdoptionSighting[] = []
    for (const row of rows) {
      // A row that already names its workspace is not a discovery.
      if (row.projectId) continue
      if (row.sourceRoot) {
        out.push({
          origin: "worktree",
          path: row.sourceRoot,
          ...(row.branch ? { label: row.branch } : {}),
        })
      } else if (row.path) {
        // No source root recorded — an adopted directory rather than a cut
        // worktree, so its own path IS the repository.
        out.push({ origin: "environment", path: row.path })
      }
    }
    return out
  } catch {
    return []
  }
}

export function useAdoptionCandidates(): UseAdoptionCandidatesResult {
  const projects = useProjectStore((s) => s.projects)
  const terminalSessions = useTerminalStore((s) => s.sessions)
  const [registry, setRegistry] = useState<AdoptionSighting[]>([])
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissedAdoptions())
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    void collectRegistrySightings().then((rows) => {
      if (cancelled) return
      setRegistry(rows)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const terminalSightings = useMemo<AdoptionSighting[]>(
    () =>
      Object.values(terminalSessions ?? {})
        .filter((row) => Boolean(row.cwd))
        .map((row) => ({ origin: "terminal" as const, path: row.cwd! })),
    [terminalSessions]
  )

  const candidates = useMemo(
    () => buildAdoptionCandidates([...registry, ...terminalSightings], projects, dismissed),
    [registry, terminalSightings, projects, dismissed]
  )

  const dismiss = useCallback((path: string) => {
    setDismissed(dismissAdoption(path))
  }, [])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return { candidates, ready, dismiss, refresh }
}
