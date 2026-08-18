"use client"

// Project Editor tab for the Agent Team workspace. Roots a real code editor at
// the team's working directory (or a selected worktree): on-disk file tree
// (workspace-fs), multi-file tabs, cross-file LSP (file:// workspaceFolder),
// project-wide search, and external-change awareness. Desktop / paired-web only.

import { useTranslations } from "next-intl"
import { isTauri } from "@/lib/tauri"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { useCodeServerSupported } from "@/hooks/codeserver/use-code-server-supported"
import type { CodeServerProfile } from "@/lib/codeserver/client"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { AgentTeam } from "@/types/agent/agent-team"
import { CodeServerPane } from "@/components/editor/project/code-server-pane"
import { EditorEngineToggle } from "@/components/editor/project/editor-engine-toggle"
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
  const scopeKey = `team:${team.id}`
  const persistedMode = useProjectEditorSessionStore(
    (state) => state.sessions[scopeKey]?.editorMode
  )
  const persistedProfile = useProjectEditorSessionStore(
    (state) => state.sessions[scopeKey]?.proIdeProfile
  )
  const setEditorSession = useProjectEditorSessionStore((state) => state.setSession)
  // Persist the engine selection so a Chat → Editor file jump remounts the
  // editor that the user actually selected, including CodeServer.
  const mode = isTauri() && persistedMode === "codeserver" ? "codeserver" : "monaco"
  const setMode = (next: "monaco" | "codeserver") => {
    setEditorSession(scopeKey, { editorMode: next })
  }
  // The trust domain rides in the same per-scope record as the engine, so the
  // tab reopens into the editor the user actually left — the profile is a
  // different code-server process, not a setting on one.
  const proIdeProfile = persistedProfile === "native" ? "native" : "managed"
  const setProIdeProfile = (next: CodeServerProfile) => {
    setEditorSession(scopeKey, { proIdeProfile: next })
  }
  const proIdeSupport = useCodeServerSupported(isTauri())

  const workbench = useProjectEditorWorkbench({
    scopeKey,
    workingDir,
    registerProjectOpener: mode === "monaco",
  })
  const { roots, rootKey, rootPath, selectRoot } = workbench.editor

  // The editor fills the workspace pane (the page shell gives this tab the same
  // full-height treatment as chat) with a floor, so a short window still leaves
  // a usable editor rather than a sliver — and the page no longer scrolls under
  // the native code-server webview, which cannot follow DOM scroll.
  return (
    <div
      className="flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-md border"
      data-testid="agent-team-editor"
      onKeyDown={workbench.onKeyDown}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <ProjectRootSwitcher roots={roots} rootKey={rootKey} onSelect={selectRoot} />
        <div className="flex-1" />
        {isTauri() && (
          <EditorEngineToggle
            value={mode}
            onChange={setMode}
            proIdeSupport={proIdeSupport}
            projectRoot={rootPath}
            proIdeProfile={proIdeProfile}
            onProIdeProfileChange={setProIdeProfile}
          />
        )}
      </div>
      {mode === "codeserver" ? (
        <div className="min-h-0 flex-1">
          <CodeServerPane
            root={rootPath}
            ownerId={scopeKey}
            profile={proIdeProfile}
            onRevoked={() => setMode("monaco")}
            onCancelled={() => setMode("monaco")}
          />
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
