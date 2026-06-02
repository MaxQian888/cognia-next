"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useProjectStore } from "@/stores/project/project-store"
import { allRootPaths } from "@/lib/workspace/roots"
import { isWorkspaceTrusted, trustWorkspace } from "@/lib/db/trusted-workspaces"
import { isTauri } from "@/lib/tauri"
import type { WorkspaceRoot, WorkspaceTrustState } from "@/types/workspace"

export interface UseWorkspaceTrust {
  /** True when the active workspace has any untrusted root (never on Web). */
  restricted: boolean
  /** Roots of the active workspace that are not yet trusted. */
  untrustedRoots: WorkspaceRoot[]
  /** path → trust verdict for every active-workspace root. */
  trustState: Record<string, WorkspaceTrustState>
  /** Trust a single root path, then refresh. */
  trustRoot: (path: string) => Promise<void>
  /** Trust every currently-untrusted root, then refresh. */
  trustAll: () => Promise<void>
}

/**
 * Derived Workspace Trust state for the active workspace. A workspace is
 * restricted iff any of its roots is untrusted. Web (no real local FS) is never
 * restricted. Mirrors the VS Code workspace-trust model; the actual ledger +
 * Rust gate live in `lib/db/trusted-workspaces`.
 */
export function useWorkspaceTrust(): UseWorkspaceTrust {
  const active = useProjectStore((s) => {
    const id = s.activeProjectId
    return id ? (s.projects.find((p) => p.id === id) ?? null) : null
  })
  const roots = useMemo(() => active?.roots ?? [], [active])
  const paths = useMemo(() => (active ? allRootPaths(active) : []), [active])
  const [trustState, setTrustState] = useState<Record<string, WorkspaceTrustState>>({})
  const onWeb = !isTauri()

  const refresh = useCallback(async () => {
    if (onWeb || paths.length === 0) {
      setTrustState({})
      return
    }
    const entries = await Promise.all(
      paths.map(
        async (p) =>
          [p, (await isWorkspaceTrusted(p)) ? "trusted" : "untrusted"] as [
            string,
            WorkspaceTrustState,
          ]
      )
    )
    setTrustState(Object.fromEntries(entries))
  }, [onWeb, paths])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async trust load
    void refresh()
  }, [refresh])

  const untrustedRoots = useMemo(
    () => roots.filter((r) => trustState[r.path] === "untrusted"),
    [roots, trustState]
  )
  const restricted = !onWeb && untrustedRoots.length > 0

  const trustRoot = useCallback(
    async (path: string) => {
      await trustWorkspace(path)
      await refresh()
    },
    [refresh]
  )
  const trustAll = useCallback(async () => {
    for (const r of untrustedRoots) await trustWorkspace(r.path)
    await refresh()
  }, [untrustedRoots, refresh])

  return { restricted, untrustedRoots, trustState, trustRoot, trustAll }
}
