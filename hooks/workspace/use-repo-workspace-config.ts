"use client"

/**
 * The repository configuration a workspace is currently seeing, and the one
 * control that changes it.
 *
 * Approval is a decision only a person can make, so it needs a surface. This is
 * the read side of `lib/project-environment/workspace-config-trust`, wired to
 * the workspace list and the settings store so a panel can render the verdict
 * without re-deriving trust for itself — the failure mode being a panel that
 * says "approved" while the runtime says "restricted".
 *
 * It re-reads after approving rather than assuming success: the file can change
 * between the render and the click, and silently approving a digest the user
 * never looked at is the whole thing this gate exists to prevent.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  approveWorkspaceConfig as persistApproval,
  getTrustedWorkspace,
  recordSeededDeclarations,
  type TrustedWorkspace,
} from "@/lib/db/trusted-workspaces"
import {
  approvalKeyFor,
  evaluateWorkspaceConfig,
  type EvaluateWorkspaceConfigDeps,
  type WorkspaceConfigVerdict,
} from "@/lib/project-environment/workspace-config-trust"
import { declaredWorkspaceOf, seedDeclarations } from "@/lib/workspace/repo-declared"
import { isTauri } from "@/lib/tauri"
import type { Project } from "@/types"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface RepoWorkspaceConfigState {
  verdict: WorkspaceConfigVerdict
  loading: boolean
  approving: boolean
  /** Absolute path the approval is recorded against, or null. */
  approvalKey: string | null
  /** Record approval of the digest currently on screen. */
  approve: () => Promise<void>
  refresh: () => void
}

export interface UseRepoWorkspaceConfigDeps extends Partial<EvaluateWorkspaceConfigDeps> {
  approve: (path: string, digest: string) => Promise<boolean>
  /** The trust row, for the declarations already offered on this device. */
  trustRecord: (path: string) => Promise<TrustedWorkspace | undefined>
  /** Persist the seeded set. Written together with the workspace change. */
  recordSeeded: (path: string, seeded: readonly string[]) => Promise<boolean>
  /** Apply the seeded roots and capability overlay to the workspace row. */
  applyToWorkspace: (projectId: string, patch: Partial<Project>) => void
}

const LOADING: WorkspaceConfigVerdict = { kind: "absent" }

export function useRepoWorkspaceConfig(
  projectId: string | null | undefined,
  executionRoot: string | null | undefined,
  deps?: Partial<UseRepoWorkspaceConfigDeps>
): RepoWorkspaceConfigState {
  const projects = useProjectStore((state) => state.projects)
  const trustEnabled = useSettingsStore(
    (state) => state.settings?.workspaceTrust?.enabled !== false
  )
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId]
  )

  const [nonce, setNonce] = useState(0)
  const approvalKey = useMemo(() => approvalKeyFor(project), [project])

  // Everything the verdict depends on, as one string. The read is asynchronous,
  // so `loading` is derived from "the settled answer is for a different key"
  // rather than set at the top of an effect — a synchronous setState there
  // costs a cascading render and the lint rule that forbids it is right.
  const requestKey = useMemo(
    () =>
      [
        executionRoot ?? "",
        trustEnabled ? "1" : "0",
        (project?.roots ?? []).map((root) => root.path).join(","),
        nonce,
      ].join("|"),
    [executionRoot, trustEnabled, project, nonce]
  )

  const [settled, setSettled] = useState<{ key: string; verdict: WorkspaceConfigVerdict } | null>(
    null
  )
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void evaluateWorkspaceConfig(
      {
        configRoot: executionRoot,
        project,
        trustEnabled,
        onWeb: !isTauri(),
      },
      deps
    )
      .then((next) => {
        if (!cancelled) setSettled({ key: requestKey, verdict: next })
      })
      .catch((cause) => {
        if (cancelled) return
        // A panel that shows nothing when the read fails is how a user
        // concludes the repository ships no configuration at all.
        setSettled({
          key: requestKey,
          verdict: {
            kind: "invalid",
            message: cause instanceof Error ? cause.message : String(cause),
            field: "workspace.json",
          },
        })
      })
    return () => {
      cancelled = true
    }
    // `deps` is a test seam and stable in production; including it would make
    // an inline object re-read on every render. `requestKey` covers the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  const fresh = settled?.key === requestKey
  const verdict = fresh ? settled.verdict : LOADING
  const loading = !fresh

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const approve = useCallback(async () => {
    if (verdict.kind !== "unapproved" || !approvalKey || !project) return
    setApproving(true)
    try {
      const persist = deps?.approve ?? persistApproval
      await persist(approvalKey, verdict.digest)
      // Approval is the moment the user says yes to THIS content, so it is also
      // the moment the repository's non-script declarations take effect. Seeded
      // once and recorded, so removing a seeded root or clearing a seeded
      // capability sticks rather than coming back on the next pull.
      const readTrust = deps?.trustRecord ?? getTrustedWorkspace
      const alreadySeeded = (await readTrust(approvalKey).catch(() => undefined))
        ?.seededDeclarations
      const seed = seedDeclarations({
        declared: declaredWorkspaceOf(verdict.config),
        overlay: project.capabilityOverlay,
        roots: project.roots ?? [],
        alreadySeeded: alreadySeeded ?? [],
        repositoryRoot: approvalKey,
      })
      if (seed.changed) {
        const apply =
          deps?.applyToWorkspace ??
          ((id: string, patch: Partial<Project>) =>
            useProjectStore.getState().updateProject(id, patch))
        apply(project.id, { capabilityOverlay: seed.overlay, roots: seed.roots })
        await (deps?.recordSeeded ?? recordSeededDeclarations)(approvalKey, seed.seeded)
      }
    } finally {
      setApproving(false)
      // Re-read rather than assume: the file can change between render and
      // click, and the panel must never claim an approval the gate would not
      // agree with.
      setNonce((n) => n + 1)
    }
  }, [verdict, approvalKey, project, deps])

  return { verdict, loading, approving, approvalKey, approve, refresh }
}
