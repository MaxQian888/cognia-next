"use client"

// Project Editor tab for the Agent Team workspace. Roots a real code editor at
// the team's working directory (or a selected worktree): on-disk file tree
// (workspace-fs), multi-file tabs, cross-file LSP (file:// workspaceFolder),
// project-wide search, and external-change awareness. Desktop / paired-web only.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CodeIcon, SquareCodeIcon } from "lucide-react"
import { isTauri } from "@/lib/tauri"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { codeServerClient } from "@/lib/codeserver/client"
import { cn } from "@/lib/utils"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { AgentTeam } from "@/types/agent/agent-team"
import { CodeServerPane } from "./code-server-pane"
import { ProjectRootSwitcher } from "@/components/editor/project/project-root-switcher"
import {
  ProjectEditorFileWorkbench,
  useProjectEditorWorkbench,
} from "@/components/editor/project/project-editor-workbench"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"

interface Props {
  team: AgentTeam
}

export function AgentTeamEditor({ team }: Props) {
  const t = useTranslations("projectEditor")
  const tTeam = useTranslations("agentTeamsWorkspace.editor")
  const workingDir = team.config.workingDir

  if (!hasWorkspaceFsBackend() || !workingDir) {
    return (
      <Empty data-testid="editor-unavailable">
        <EmptyHeader>
          <EmptyTitle>{t("unavailableTitle")}</EmptyTitle>
          <EmptyDescription>
            {workingDir ? t("unavailableDesc") : tTeam("noWorkingDir")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return <ProjectEditorBody team={team} workingDir={workingDir} />
}

function ProjectEditorBody({ team, workingDir }: { team: AgentTeam; workingDir: string }) {
  const tTeam = useTranslations("agentTeamsWorkspace.editor")
  const scopeKey = `team:${team.id}`
  const persistedMode = useProjectEditorSessionStore(
    (state) => state.sessions[scopeKey]?.editorMode
  )
  const setEditorSession = useProjectEditorSessionStore((state) => state.setSession)
  // Persist the engine selection so a Chat → Editor file jump remounts the
  // editor that the user actually selected, including CodeServer.
  const mode = isTauri() && persistedMode === "codeserver" ? "codeserver" : "monaco"
  const setMode = (next: "monaco" | "codeserver") => {
    setEditorSession(scopeKey, { editorMode: next })
  }
  const [proIdeSupported, setProIdeSupported] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    void codeServerClient
      .supported()
      .then((ok) => {
        if (alive) setProIdeSupported(ok)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const workbench = useProjectEditorWorkbench({
    scopeKey,
    workingDir,
    registerProjectOpener: mode === "monaco",
  })
  const { roots, rootKey, rootPath, selectRoot } = workbench.editor

  return (
    <div
      className="flex h-[70vh] min-h-0 flex-col overflow-hidden rounded-md border"
      data-testid="agent-team-editor"
      onKeyDown={workbench.onKeyDown}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <ProjectRootSwitcher roots={roots} rootKey={rootKey} onSelect={selectRoot} />
        <div className="flex-1" />
        {isTauri() && (
          <div
            className="flex items-center gap-0.5 rounded-md border p-0.5"
            role="group"
            aria-label={tTeam("proIde.switchLabel")}
          >
            <button
              type="button"
              data-testid="editor-mode-monaco"
              aria-pressed={mode === "monaco"}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                mode === "monaco" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setMode("monaco")}
            >
              <CodeIcon className="size-3.5" />
              {tTeam("proIde.toggleMonaco")}
            </button>
            <button
              type="button"
              data-testid="editor-mode-codeserver"
              aria-pressed={mode === "codeserver"}
              disabled={!proIdeSupported}
              title={proIdeSupported ? undefined : tTeam("proIde.disabledTooltip")}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50",
                mode === "codeserver" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setMode("codeserver")}
            >
              <SquareCodeIcon className="size-3.5" />
              {tTeam("proIde.toggleVsCode")}
            </button>
          </div>
        )}
      </div>
      {mode === "codeserver" ? (
        <div className="min-h-0 flex-1">
          <CodeServerPane root={rootPath} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <ProjectEditorFileWorkbench
            workbench={workbench}
            sidebarPosition="left"
            panelIdPrefix="agent-team-editor"
            showTabs
          />
        </div>
      )}
    </div>
  )
}
