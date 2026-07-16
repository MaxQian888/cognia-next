"use client"

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react"
import { FilesIcon, SearchIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import type { EditorActionDef } from "@/lib/editor-workbench/register-editor-actions"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"
import { cn } from "@/lib/utils"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"
import { ProjectEditorTabs } from "./project-editor-tabs"
import { ProjectFileTree } from "./project-file-tree"
import { ProjectMonaco } from "./project-monaco"
import { ProjectSearchPanel } from "./project-search-panel"
import { useProjectEditor, type UseProjectEditorArgs } from "./use-project-editor"

interface UseProjectEditorWorkbenchArgs extends UseProjectEditorArgs {
  beforeOpen?: () => void
}

export function useProjectEditorWorkbench({
  scopeKey,
  workingDir,
  deps,
  beforeOpen,
}: UseProjectEditorWorkbenchArgs) {
  const t = useTranslations("projectEditor")
  const bindings = useKeybindingStore((state) => state.bindings)
  const [sideTab, setSideTab] = useState<"files" | "search">("files")
  const editor = useProjectEditor({ scopeKey, workingDir, deps })
  const { activeFile, activePath, openFile, rootPath, saveAll, saveFile } = editor

  const gotoLine = useCallback(
    (relPath: string, line?: number, column?: number) => {
      beforeOpen?.()
      void openFile(relPath).then(() => {
        if (line === undefined) return
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
              detail: { relPath, line, column: column ?? 1 },
            })
          )
        }, 0)
      })
    },
    [beforeOpen, openFile]
  )

  useEffect(
    () =>
      registerProjectEditorOpener({
        root: rootPath,
        open: gotoLine,
      }),
    [gotoLine, rootPath]
  )

  const saveActive = useCallback(() => {
    if (!activePath) return
    void saveFile(activePath).catch((error) =>
      toast.error(t("saveFailed", { error: String(error) }))
    )
  }, [activePath, saveFile, t])

  const saveEveryFile = useCallback(() => {
    void saveAll().catch((error) => toast.error(t("saveFailed", { error: String(error) })))
  }, [saveAll, t])

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
        label: actionLabels["file.save"],
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 1,
        alwaysAvailable: true,
        run: saveActive,
      },
      {
        id: "file.format",
        label: actionLabels["file.format"],
        monacoCommand: "editor.action.formatDocument",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 2,
        alwaysAvailable: true,
      },
      {
        id: "file.copyPath",
        label: actionLabels["file.copyPath"],
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 1,
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.absolutePath)
        },
      },
      {
        id: "file.copyRelativePath",
        label: actionLabels["file.copyRelativePath"],
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 2,
        alwaysAvailable: true,
        run: () => {
          if (activeFile) void navigator.clipboard?.writeText(activeFile.relPath)
        },
      },
      {
        id: "file.searchProject",
        label: actionLabels["file.searchProject"],
        contextMenuGroupId: "z_search",
        alwaysAvailable: true,
        run: () => setSideTab("search"),
      },
    ],
    [actionLabels, activeFile, saveActive]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      if (event.shiftKey) saveEveryFile()
      else saveActive()
    },
    [saveActive, saveEveryFile]
  )

  return {
    editor,
    bindings,
    sideTab,
    setSideTab,
    gotoLine,
    saveActive,
    saveAll: saveEveryFile,
    actionLabels,
    actions,
    onKeyDown,
  }
}

export type ProjectEditorWorkbenchController = ReturnType<typeof useProjectEditorWorkbench>

interface ProjectEditorFileWorkbenchProps {
  workbench: ProjectEditorWorkbenchController
  sidebarPosition: "left" | "right"
  panelIdPrefix: string
  showTabs?: boolean
  emptyTestId?: string
}

export function ProjectEditorFileWorkbench({
  workbench,
  sidebarPosition,
  panelIdPrefix,
  showTabs = false,
  emptyTestId = "editor-empty",
}: ProjectEditorFileWorkbenchProps) {
  const t = useTranslations("projectEditor")
  const { actions, actionLabels, bindings, editor, gotoLine, saveAll, sideTab, setSideTab } =
    workbench
  const {
    activeFile,
    activePath,
    closeFile,
    deps,
    dirtyCount,
    openFiles,
    rootPath,
    setActivePath,
    setDraft,
    treeRefreshToken,
  } = editor

  const sidebar = (
    <ResizablePanel
      id={`${panelIdPrefix}-sidebar`}
      defaultSize={sidebarPosition === "left" ? 24 : 28}
      minSize={sidebarPosition === "left" ? 14 : 18}
      className="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 border-b">
          <button
            type="button"
            data-testid="left-tab-files"
            className={cn(
              "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
              sideTab === "files" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
            )}
            onClick={() => setSideTab("files")}
          >
            <FilesIcon className="size-3.5" />
            {t("filesTab")}
          </button>
          <button
            type="button"
            data-testid="left-tab-search"
            className={cn(
              "flex flex-1 items-center justify-center gap-1 py-1 text-xs",
              sideTab === "search" ? "bg-accent" : "text-muted-foreground hover:bg-accent/50"
            )}
            onClick={() => setSideTab("search")}
          >
            <SearchIcon className="size-3.5" />
            {t("searchTab")}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {sideTab === "files" ? (
            <ProjectFileTree
              rootPath={rootPath}
              refreshToken={treeRefreshToken}
              activePath={activePath}
              onOpenFile={gotoLine}
              deps={deps}
            />
          ) : (
            <ProjectSearchPanel rootPath={rootPath} onOpenMatch={gotoLine} />
          )}
        </div>
      </div>
    </ResizablePanel>
  )

  const editorPane = (
    <ResizablePanel
      id={`${panelIdPrefix}-editor`}
      defaultSize={sidebarPosition === "left" ? 76 : 72}
      minSize={sidebarPosition === "left" ? 30 : 40}
      className="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        {showTabs ? (
          <ProjectEditorTabs
            files={openFiles}
            activePath={activePath}
            dirtyCount={dirtyCount}
            onSelect={setActivePath}
            onClose={closeFile}
            onSaveAll={saveAll}
          />
        ) : null}
        <div className="min-h-0 flex-1">
          {activeFile ? (
            <ProjectMonaco
              key={activeFile.absolutePath}
              file={activeFile}
              projectRoot={rootPath}
              onChange={(value) => setDraft(activeFile.relPath, value)}
              actions={actions}
              actionLabels={actionLabels}
              bindings={bindings}
            />
          ) : (
            <div
              className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
              data-testid={emptyTestId}
            >
              {t("emptyEditor")}
            </div>
          )}
        </div>
      </div>
    </ResizablePanel>
  )

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      {sidebarPosition === "left" ? sidebar : editorPane}
      <ResizableHandle withHandle />
      {sidebarPosition === "left" ? editorPane : sidebar}
    </ResizablePanelGroup>
  )
}
