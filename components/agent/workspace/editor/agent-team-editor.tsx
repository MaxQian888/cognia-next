"use client"

// Project Editor tab for the Agent Team workspace. Roots a real code editor at
// the team's working directory (or a selected worktree): on-disk file tree
// (workspace-fs), multi-file tabs, cross-file LSP (file:// workspaceFolder),
// project-wide search, and external-change awareness. Desktop / paired-web only.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { FilesIcon, SearchIcon } from "lucide-react"
import { isTauri } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { EditorActionDef } from "@/lib/editor-workbench/register-editor-actions"
import { useProjectEditor } from "./use-project-editor"
import { ProjectFileTree } from "./project-file-tree"
import { ProjectEditorTabs } from "./project-editor-tabs"
import { ProjectMonaco } from "./project-monaco"
import { ProjectRootSwitcher } from "./project-root-switcher"
import { ProjectSearchPanel } from "./project-search-panel"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"

interface Props {
  team: AgentTeam
}

/** True when a real filesystem backend is reachable (desktop or paired web). */
export function hasFsBackend(): boolean {
  return isTauri() || loadCompanionConfig() != null
}

export function AgentTeamEditor({ team }: Props) {
  const t = useTranslations("agentTeamsWorkspace.editor")
  const workingDir = team.config.workingDir

  if (!hasFsBackend() || !workingDir) {
    return (
      <Empty data-testid="editor-unavailable">
        <EmptyHeader>
          <EmptyTitle>{t("unavailableTitle")}</EmptyTitle>
          <EmptyDescription>
            {workingDir ? t("unavailableDesc") : t("noWorkingDir")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return <ProjectEditorBody team={team} workingDir={workingDir} />
}

function ProjectEditorBody({ team, workingDir }: { team: AgentTeam; workingDir: string }) {
  const t = useTranslations("agentTeamsWorkspace.editor")
  const bindings = useKeybindingStore((s) => s.bindings)
  const [leftTab, setLeftTab] = useState<"files" | "search">("files")

  const editor = useProjectEditor({ teamId: team.id, workingDir })
  const {
    roots,
    rootKey,
    rootPath,
    openFiles,
    activePath,
    activeFile,
    dirtyCount,
    treeRefreshToken,
    selectRoot,
    openFile,
    closeFile,
    setActivePath,
    setDraft,
    saveFile,
    saveAll,
  } = editor

  const gotoLine = useCallback(
    (relPath: string, line?: number, column?: number) => {
      void openFile(relPath).then(() => {
        if (line === undefined) return
        // Defer so the Monaco surface for the (possibly newly opened) file is
        // mounted before we ask it to reveal the position.
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
              detail: { relPath, line, column: column ?? 1 },
            })
          )
        }, 0)
      })
    },
    [openFile]
  )

  // Register a cross-surface opener so terminal path-links under this root open
  // here (editable + LSP) instead of the read-only file viewer.
  useEffect(() => {
    return registerProjectEditorOpener({
      root: rootPath,
      open: (relPath, line, column) => gotoLine(relPath, line, column),
    })
  }, [rootPath, gotoLine])

  const handleSaveActive = useCallback(() => {
    if (!activePath) return
    void saveFile(activePath).catch((err) => toast.error(t("saveFailed", { error: String(err) })))
  }, [activePath, saveFile, t])

  const handleSaveAll = useCallback(() => {
    void saveAll().catch((err) => toast.error(t("saveFailed", { error: String(err) })))
  }, [saveAll, t])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault()
        if (e.shiftKey) handleSaveAll()
        else handleSaveActive()
      }
    },
    [handleSaveActive, handleSaveAll]
  )

  // Surface-specific cognia actions injected into the Monaco context menu + F1.
  const actionLabels = useMemo<Record<string, string>>(
    () => ({
      "file.save": t("action.save"),
      "file.format": t("action.format"),
      "file.copyPath": t("action.copyPath"),
      "file.copyRelativePath": t("action.copyRelativePath"),
      "file.searchProject": t("action.searchProject"),
    }),
    [t]
  )

  const actions = useMemo<EditorActionDef[]>(
    () => [
      {
        id: "file.save",
        label: "Save",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 1,
        alwaysAvailable: true,
        run: handleSaveActive,
      },
      {
        id: "file.format",
        label: "Format Document",
        monacoCommand: "editor.action.formatDocument",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 2,
        alwaysAvailable: true,
      },
      {
        id: "file.copyPath",
        label: "Copy Path",
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 1,
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.absolutePath)
        },
      },
      {
        id: "file.copyRelativePath",
        label: "Copy Relative Path",
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 2,
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.relPath)
        },
      },
      {
        id: "file.searchProject",
        label: "Search in Project",
        contextMenuGroupId: "z_search",
        alwaysAvailable: true,
        run: () => setLeftTab("search"),
      },
    ],
    [activeFile, handleSaveActive]
  )

  return (
    <div
      className="flex h-[70vh] min-h-0 flex-col overflow-hidden rounded-md border"
      data-testid="agent-team-editor"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <ProjectRootSwitcher roots={roots} rootKey={rootKey} onSelect={selectRoot} />
        <div className="flex-1" />
      </div>
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={24} minSize={14} className="min-h-0">
          <div className="flex h-full flex-col">
            <div className="flex border-b">
              <button
                type="button"
                data-testid="left-tab-files"
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
                  leftTab === "files" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setLeftTab("files")}
              >
                <FilesIcon className="size-3.5" />
                {t("filesTab")}
              </button>
              <button
                type="button"
                data-testid="left-tab-search"
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
                  leftTab === "search" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setLeftTab("search")}
              >
                <SearchIcon className="size-3.5" />
                {t("searchTab")}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {leftTab === "files" ? (
                <ProjectFileTree
                  rootPath={rootPath}
                  refreshToken={treeRefreshToken}
                  activePath={activePath}
                  onOpenFile={(rel) => void openFile(rel)}
                  deps={editor.deps}
                />
              ) : (
                <ProjectSearchPanel rootPath={rootPath} onOpenMatch={gotoLine} />
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={76} minSize={30} className="min-h-0">
          <div className="flex h-full flex-col">
            <ProjectEditorTabs
              files={openFiles}
              activePath={activePath}
              dirtyCount={dirtyCount}
              onSelect={setActivePath}
              onClose={closeFile}
              onSaveAll={handleSaveAll}
            />
            <div className="min-h-0 flex-1">
              {activeFile ? (
                <ProjectMonaco
                  key={activeFile.absolutePath}
                  file={activeFile}
                  projectRoot={rootPath}
                  onChange={(v) => setDraft(activeFile.relPath, v)}
                  actions={actions}
                  actionLabels={actionLabels}
                  bindings={bindings}
                />
              ) : (
                <div
                  className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
                  data-testid="editor-empty"
                >
                  {t("emptyEditor")}
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
