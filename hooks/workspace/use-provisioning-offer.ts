"use client"

/**
 * The worktree-provisioning proposal for one workspace, and the two buttons
 * that answer it.
 *
 * The read side is a directory listing plus one pnpm probe; the write side is a
 * field on the workspace row. Both are deliberately here rather than in
 * `lib/workspace/provisioning-inference`, which stays a pure function of a
 * listing so the rules can be tested without a filesystem.
 *
 * # Two listings, not one
 *
 * "Is `node_modules` ignored here" is the question that decides whether a cache
 * link is safe to propose, and the only way to answer it from the file bridge
 * is to list the root twice — once respecting `.gitignore`, once not — and
 * subtract. It is two native calls at one directory's depth, paid when the
 * settings card opens, never on the acquisition path.
 *
 * # Why the probe does not run at acquisition time
 *
 * `provisioningFromConsent` rebuilds the payload from the stored ids alone, so
 * opening a worktree costs no listing and no process spawn. This hook exists
 * for the moment a person is looking at the card.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  EMPTY_CONSENT,
  inferProvisioning,
  pendingCandidates,
  withDecision,
  type ProbeEntry,
  type PnpmVirtualStore,
  type ProvisioningCandidate,
  type ProvisioningConsent,
} from "@/lib/workspace/provisioning-inference"
import { probePnpmVirtualStore } from "@/lib/workspace/pnpm-virtual-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

export interface ProvisioningOfferState {
  /** Everything the probe supports right now, accepted or not. */
  candidates: ProvisioningCandidate[]
  /** Candidates the user has not answered yet. */
  pending: ProvisioningCandidate[]
  consent: ProvisioningConsent
  pnpm: PnpmVirtualStore
  /** True while there is no probe result for the current root. */
  loading: boolean
  decide: (ids: readonly string[], accept: boolean) => void
  refresh: () => void
}

export interface UseProvisioningOfferDeps {
  listRoot: (root: string, includeIgnored: boolean) => Promise<ProbeEntry[]>
  probePnpm: (root: string) => Promise<PnpmVirtualStore>
  applyToWorkspace: (projectId: string, patch: Partial<Project>) => void
}

const DEFAULT_DEPS: UseProvisioningOfferDeps = {
  listRoot: async (root, includeIgnored) => {
    const { listWorkspaceDir } = await import("@/lib/files/workspace-fs")
    const entries = await listWorkspaceDir(root, undefined, includeIgnored)
    return entries.map((entry) => ({ name: entry.relPath, isDir: entry.isDir }))
  },
  probePnpm: (root) => probePnpmVirtualStore(root),
  applyToWorkspace: (projectId, patch) =>
    useProjectStore.getState().updateProject(projectId, patch),
}

interface Probed {
  key: string
  candidates: ProvisioningCandidate[]
  pnpm: PnpmVirtualStore
}

export function useProvisioningOffer(
  projectId: string | null | undefined,
  executionRoot: string | null | undefined,
  deps?: Partial<UseProvisioningOfferDeps>
): ProvisioningOfferState {
  const projects = useProjectStore((state) => state.projects)
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId]
  )
  const consent = project?.workspaceProvisioning ?? EMPTY_CONSENT

  const [nonce, setNonce] = useState(0)
  const root = executionRoot?.trim() ?? ""
  const requestKey = `${root}|${nonce}`
  const [settled, setSettled] = useState<Probed | null>(null)

  useEffect(() => {
    // No root means nothing to probe. Returning without a setState keeps the
    // effect out of the cascading-render path the lint rule guards; `loading`
    // below reads the same "no root" condition directly.
    if (!root) return
    let cancelled = false
    const resolved: UseProvisioningOfferDeps = { ...DEFAULT_DEPS, ...deps }
    void (async () => {
      // A failed listing means "we know nothing", not "there is nothing to
      // provision" — but there is no honest proposal to make from it either,
      // so the card falls back to the empty state rather than guessing.
      const [all, visible] = await Promise.all([
        resolved.listRoot(root, true).catch(() => [] as ProbeEntry[]),
        resolved.listRoot(root, false).catch(() => [] as ProbeEntry[]),
      ])
      const visibleNames = new Set(visible.map((entry) => entry.name))
      const ignored = all
        .filter((entry) => !visibleNames.has(entry.name))
        .map((entry) => entry.name)
      const pnpm = await resolved.probePnpm(root).catch<PnpmVirtualStore>(() => "unknown")
      if (cancelled) return
      setSettled({
        key: requestKey,
        candidates: inferProvisioning({ entries: all, ignored, pnpm }),
        pnpm,
      })
    })()
    return () => {
      cancelled = true
    }
    // `deps` is a test seam and stable in production; an inline object would
    // re-probe on every render. `requestKey` covers what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, root])

  const settledForKey = settled?.key === requestKey ? settled : null
  const candidates = settledForKey?.candidates ?? []
  const pnpm = settledForKey?.pnpm ?? "unknown"

  const decide = useCallback(
    (ids: readonly string[], accept: boolean) => {
      if (!project || !ids.length) return
      const apply = deps?.applyToWorkspace ?? DEFAULT_DEPS.applyToWorkspace
      apply(project.id, {
        workspaceProvisioning: withDecision(project.workspaceProvisioning, ids, accept),
      })
    },
    [project, deps]
  )

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return {
    candidates,
    pending: pendingCandidates(candidates, consent),
    consent,
    pnpm,
    loading: Boolean(root) && !settledForKey,
    decide,
    refresh,
  }
}
