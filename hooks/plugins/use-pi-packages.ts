"use client"

/**
 * State for the Agent Packages section (ADR-0119).
 *
 * Keeps the two scopes separate all the way to the UI. There is deliberately no
 * `packages` field that flattens them: Pi resolves the two lists with a rule
 * (`resolvePiPackages`) that the UI has to show, not hide — a project entry can
 * either replace a user entry or layer over it, and a single merged array
 * cannot express the difference.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { computePiContextBudget, type PiContextBudget } from "@/lib/pi-packages/budget"
import { detectPiOverlaps, piDiscouragedPackages } from "@/lib/pi-packages/conflicts"
import {
  loadPiPackages,
  runPiMutation,
  setPiPackageEnabled,
  type PiMutationOutcome,
  type PiPackagesSnapshot,
} from "@/lib/pi-packages/host"
import type { PiMutationRequest } from "@/lib/pi-packages/mutate"
import { resolvePiPackages, type ResolvedPiPackage } from "@/lib/pi-packages/resolve"
import { projectSettingsPath } from "@/lib/pi-packages/settings-io"
import type { PiPackageScope } from "@/lib/pi-packages/types"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

export interface UsePiPackagesResult {
  loading: boolean
  snapshot: PiPackagesSnapshot | null
  /** Both scopes merged by Pi's own rule, project entries first. */
  resolved: ResolvedPiPackage[]
  budget: PiContextBudget
  overlaps: ReturnType<typeof detectPiOverlaps>
  discouraged: ReturnType<typeof piDiscouragedPackages>
  /** True when Pi's user settings file is absent — Pi is likely not installed. */
  piMissing: boolean
  /** Warnings from parsing either file (unknown fields, malformed entries). */
  warnings: string[]
  /** Absolute path a project-scope write would touch, for the confirm dialog. */
  projectPath: string | null
  /**
   * Schedule a re-read. Returns as soon as the refetch is queued, not when it
   * lands — `loading` goes true immediately and false when the new snapshot
   * arrives, so that flag is what a caller should render against.
   */
  reload: () => Promise<void>
  mutate: (request: PiMutationRequest) => Promise<PiMutationOutcome>
  setEnabled: (
    spec: string,
    scope: PiPackageScope,
    enabled: boolean
  ) => Promise<{ ok: boolean; error?: string }>
}

export function usePiPackages(): UsePiPackagesResult {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  const cwd = useMemo(() => {
    const project = projects.find((p) => p.id === activeProjectId)
    return project ? (primaryRootOf(project)?.path ?? null) : null
  }, [projects, activeProjectId])

  /**
   * One state cell holding the snapshot *and* what it was loaded for. `loading`
   * is then derived rather than stored, which is what keeps the effect free of a
   * synchronous `setState(true)` on every cwd change — that pattern causes a
   * cascading render and is what `react-hooks/set-state-in-effect` flags.
   *
   * `nonce` is bumped by `reload()`, giving the effect an explicit refetch
   * trigger without a second source of truth for "am I loading".
   */
  const [loaded, setLoaded] = useState<{
    cwd: string | null
    nonce: number
    snapshot: PiPackagesSnapshot
  } | null>(null)
  const [nonce, setNonce] = useState(0)

  const loading = loaded === null || loaded.cwd !== cwd || loaded.nonce !== nonce
  const snapshot = loaded?.snapshot ?? null

  const reload = useCallback(async () => {
    setNonce((current) => current + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadPiPackages(cwd).then((next) => {
      if (!cancelled) setLoaded({ cwd, nonce, snapshot: next })
    })
    return () => {
      cancelled = true
    }
  }, [cwd, nonce])

  const resolved = useMemo(() => {
    if (!snapshot) return []
    return resolvePiPackages(snapshot.user.packages, snapshot.project.packages, {
      // Each scope resolves relative local specs against its own base, so a
      // `./ext` in both files stays two packages rather than collapsing into
      // one and losing an entry.
      user: snapshot.userBaseDir ?? undefined,
      project: snapshot.projectCwd ? `${snapshot.projectCwd}/.pi` : undefined,
    })
  }, [snapshot])

  // The budget and conflict views describe what Pi will actually load, so they
  // read the resolved list — not the raw user array, which can contain entries
  // a project scope has replaced.
  const activeSpecs = useMemo(() => resolved.map((entry) => entry.pkg), [resolved])

  const mutate = useCallback(
    async (request: PiMutationRequest) => {
      const outcome = await runPiMutation(request, {
        cwd,
        cli: snapshot?.cli ?? { available: false },
      })
      if (outcome.ok) await reload()
      return outcome
    },
    [cwd, snapshot?.cli, reload]
  )

  const setEnabled = useCallback(
    async (spec: string, scope: PiPackageScope, enabled: boolean) => {
      const result = await setPiPackageEnabled(spec, scope, enabled, { cwd })
      if (result.ok) await reload()
      return result
    },
    [cwd, reload]
  )

  return {
    loading,
    snapshot,
    resolved,
    budget: useMemo(() => computePiContextBudget(activeSpecs), [activeSpecs]),
    overlaps: useMemo(() => detectPiOverlaps(activeSpecs), [activeSpecs]),
    discouraged: useMemo(() => piDiscouragedPackages(activeSpecs), [activeSpecs]),
    piMissing: snapshot ? snapshot.user.missing : false,
    warnings: useMemo(
      () => [...(snapshot?.user.warnings ?? []), ...(snapshot?.project.warnings ?? [])],
      [snapshot]
    ),
    projectPath: cwd ? projectSettingsPath(cwd) : null,
    reload,
    mutate,
    setEnabled,
  }
}
