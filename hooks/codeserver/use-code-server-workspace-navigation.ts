"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  CODESERVER_EVENTS,
  type CodeServerEditorEvent,
  type CodeServerWorkspaceRow,
} from "@/lib/codeserver/client"
import {
  resolveWorkspaceRowHref,
  type WorkspaceRowTargetDeps,
} from "@/lib/codeserver/workspace-row-target"
import { getIssueRun } from "@/lib/db/issue-runs"
import { getPlan } from "@/lib/db/plans"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

const defaultDeps: WorkspaceRowTargetDeps = { getPlan, getIssueRun }

/**
 * Open in Cognia whatever a clicked Pro IDE workspace-panel row names.
 *
 * The extension opens a row that carries a file path itself; everything else
 * (and a path that no longer exists) comes back as `workspaceRowActivated`.
 * Before this nothing listened, so clicking a plan or a run in VS Code's
 * Cognia panel did nothing at all.
 */
export function useCodeServerWorkspaceNavigation(
  enabled: boolean,
  root: string,
  deps: WorkspaceRowTargetDeps = defaultDeps
): void {
  const router = useRouter()
  const t = useTranslations("projectEditor.proIde")
  const tRef = useRef(t)
  const depsRef = useRef(deps)
  useEffect(() => {
    tRef.current = t
    depsRef.current = deps
  }, [t, deps])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<CodeServerEditorEvent>(CODESERVER_EVENTS.editorEvent, (event) => {
      if (cancelled || event.root !== root || event.name !== "workspaceRowActivated") return
      const row = event.payload as unknown as CodeServerWorkspaceRow | null
      if (!row || typeof row.id !== "string") return
      void resolveWorkspaceRowHref(row.id, depsRef.current).then((href) => {
        if (cancelled) return
        if (href) router.push(href)
        else toast.error(tRef.current("workspaceRowMissing", { label: row.label }))
      })
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [enabled, root, router])
}
