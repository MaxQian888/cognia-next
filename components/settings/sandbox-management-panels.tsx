"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { sandboxPreviewContext, type SandboxPreviewContext } from "@/lib/sandbox/previews"
import { listWorkspaceEnvironments } from "@/lib/task-workspace/client"
import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"
import { isTauri } from "@/lib/tauri"
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import { SandboxPreviewLinksPanel } from "./sandbox-preview-links-panel"
import { SandboxSnapshotsPanel } from "./sandbox-snapshots-panel"

/** Shared Settings/workspace entry point; all runtime identities come from the Host. */
export function SandboxManagementPanels({ projectId }: { projectId: string }) {
  const t = useTranslations("sandboxManagement")
  const [context, setContext] = useState<SandboxPreviewContext | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceEnvironmentSummary[]>([])
  const [failed, setFailed] = useState(false)
  const epoch = useRef(0)
  const [scope, setScope] = useState(projectId)
  if (scope !== projectId) {
    setScope(projectId)
    setContext(null)
    setWorkspaces([])
    setFailed(false)
  }
  const local = isTauri() && !getActiveRemoteEndpoint()
  const refresh = useCallback(async () => {
    const current = ++epoch.current
    try {
      const [next, environments] = await Promise.all([
        sandboxPreviewContext(projectId),
        listWorkspaceEnvironments(),
      ])
      if (current !== epoch.current) return
      setFailed(false)
      setContext(next)
      setWorkspaces(environments.filter((row) => row.projectId === projectId))
    } catch {
      if (current === epoch.current) {
        setContext(null)
        setFailed(true)
      }
    }
  }, [projectId])
  useEffect(() => {
    const current = epoch.current
    void Promise.resolve().then(() => {
      if (local && current === epoch.current) return refresh()
    })
    return () => {
      epoch.current += 1
    }
  }, [refresh, local])

  if (!local)
    return <p className="border-t pt-3 text-xs text-muted-foreground">{t("localRequired")}</p>
  if (failed)
    return (
      <div className="space-y-2 border-t pt-3">
        <p role="alert" className="text-xs text-destructive">
          {t("contextError")}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          {t("refresh")}
        </Button>
      </div>
    )
  if (!context)
    return (
      <p role="status" className="border-t pt-3 text-xs">
        {t("loading")}
      </p>
    )
  return (
    <div className="space-y-3" key={projectId}>
      <SandboxSnapshotsPanel
        projectId={projectId}
        context={context}
        workspaces={workspaces}
        onChanged={refresh}
      />
      <SandboxPreviewLinksPanel projectId={projectId} targets={context.targets} />
    </div>
  )
}
