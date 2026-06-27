"use client"

/**
 * ArtifactPanelContent — the shared body of the artifacts surface, rendered by
 * BOTH the Sheet (`<ArtifactPanel />`, mobile/tablet fallback) and the docked
 * panel (`<ArtifactDock />`, desktop). Extracted from the former monolithic
 * `artifact-panel.tsx` so the two hosts never drift.
 *
 * Hosts pass `panelMode` so layout decisions (mobile footer, Monaco vs the
 * light editor, the split-view tab) follow the host, not just the viewport.
 */

import dynamic from "next/dynamic"
import { useEffect, useRef } from "react"
import { Maximize2, Minimize2, MoreHorizontal, Pencil, Save, X, FileCode } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
} from "@/lib/editor-workbench/monaco-workbench"

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full p-4 space-y-2">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  ),
})

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactClose,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { ArtifactPreview } from "./artifact-preview"
import { ArtifactList } from "./artifact-list"
import { ArtifactReviewView } from "./artifact-review-view"
import { SelectionCommentButton } from "./selection-comment-button"
import { PanelVersionHistory } from "./panel-version-history"
import { ArtifactDesignerWrapper } from "./panel-designer-wrapper"
import {
  DESIGNABLE_TYPES,
  getMonacoLanguage,
  getShikiLanguage,
  MERMAID_TYPE_NAMES,
} from "@/lib/artifacts"
import { getArtifactTypeIcon } from "./artifact-icons"
import { useArtifactPanelState, type ArtifactViewMode } from "@/hooks/artifacts/use-artifact-panel"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { LspServerHint } from "@/components/editor/lsp-server-hint"
import { editorLanguageFromMonacoId } from "@/components/editor/editor-language"

type ArtifactPanelAction =
  | "modeTabs"
  | "edit"
  | "canvas"
  | "fullscreen"
  | "close"
  | "copy"
  | "download"
  | "openInNewTab"
  | "revealInExplorer"
  | "versionHistory"

export type ArtifactPanelMode = "desktop" | "tablet" | "mobile" | "fullscreen"

function getMonacoTheme(theme?: string): string {
  return theme === "dark" ? "vs-dark" : "vs"
}

export function ArtifactPanelContent({ panelMode }: { panelMode: ArtifactPanelMode }) {
  const {
    t,
    tCommon,
    activeArtifact,
    pendingReview,
    theme,
    viewMode,
    setViewMode,
    copied,
    designerOpen,
    setDesignerOpen,
    editContent,
    hasChanges,
    isFullscreen,
    showVersionHistory,
    setShowVersionHistory,
    isPreviewable,
    isDesignable,
    primaryActions,
    overflowActions,
    closePanel,
    handleOpenInCanvas,
    handleEditMode,
    handleSaveEdit,
    handleCancelEdit,
    handleEditorChange,
    toggleFullscreen,
    handleCopy,
    handleDownload,
    handleOpenInNewTab,
    handleRevealInExplorer,
  } = useArtifactPanelState()

  // Workbench wiring for the VS Code reuse layer: when the artifact's Monaco
  // editor mounts, attach a stable `artifact:///{id}.{ext}` URI so LSP
  // providers bind to it. Tear down on artifact change / unmount.
  const workbenchHandleRef = useRef<MonacoWorkbenchHandle | null>(null)
  const activeArtifactId = activeArtifact?.id ?? null
  useEffect(() => {
    return () => {
      workbenchHandleRef.current?.dispose()
      workbenchHandleRef.current = null
    }
  }, [activeArtifactId])

  // The split view (code + live preview) is the wide-dock-only Codex layout.
  const canSplit = isPreviewable && panelMode !== "mobile"

  const artifactMetadata = activeArtifact
    ? `v${activeArtifact.version} · ${activeArtifact.language || activeArtifact.type}${
        activeArtifact.type === "mermaid"
          ? (() => {
              const match = activeArtifact.content.match(/^(\w+)/m)
              const diagramType = match ? MERMAID_TYPE_NAMES[match[1]] : null
              return diagramType ? ` · ${diagramType}` : ""
            })()
          : ""
      }${DESIGNABLE_TYPES.includes(activeArtifact.type) ? " · Designable" : ""}`
    : ""

  const renderModeTabs = () => (
    <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as ArtifactViewMode)}>
      <TabsList className="h-8">
        <TabsTrigger data-testid="artifact-tab-code" value="code" className="text-xs px-2">
          {t("code")}
        </TabsTrigger>
        {isPreviewable && (
          <TabsTrigger data-testid="artifact-tab-preview" value="preview" className="text-xs px-2">
            {t("preview")}
          </TabsTrigger>
        )}
        {canSplit && (
          <TabsTrigger data-testid="artifact-tab-split" value="split" className="text-xs px-2">
            {t("dock.splitView")}
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  )

  const renderPrimaryAction = (action: ArtifactPanelAction) => {
    switch (action) {
      case "modeTabs":
        return <div key={action}>{renderModeTabs()}</div>
      case "edit":
        return (
          <ArtifactAction
            key={action}
            data-testid="action-edit"
            tooltip={tCommon("edit")}
            icon={Pencil}
            onClick={handleEditMode}
          />
        )
      case "canvas":
        return (
          <ArtifactAction
            key={action}
            data-testid="action-editInCanvas"
            tooltip={t("editInCanvas")}
            icon={FileCode}
            onClick={handleOpenInCanvas}
          />
        )
      case "fullscreen":
        return (
          <ArtifactAction
            key={action}
            data-testid="action-fullscreen"
            tooltip={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
            icon={isFullscreen ? Minimize2 : Maximize2}
            onClick={toggleFullscreen}
          />
        )
      case "close":
        return <ArtifactClose key={action} data-testid="artifact-close" onClick={closePanel} />
      default:
        return null
    }
  }

  const handleOverflowAction = (action: ArtifactPanelAction) => {
    switch (action) {
      case "copy":
        return handleCopy()
      case "download":
        return handleDownload()
      case "openInNewTab":
        return handleOpenInNewTab()
      case "revealInExplorer":
        return handleRevealInExplorer()
      case "versionHistory":
        return setShowVersionHistory(!showVersionHistory)
      default:
        return undefined
    }
  }

  const getOverflowActionLabel = (action: ArtifactPanelAction) => {
    switch (action) {
      case "copy":
        return copied ? tCommon("copied") : tCommon("copy")
      case "download":
        return t("download")
      case "openInNewTab":
        return t("dock.openInNewTab")
      case "revealInExplorer":
        return t("revealInExplorer")
      case "versionHistory":
        return t("versionHistory")
      default:
        return action
    }
  }

  const renderOverflowMenu = () => {
    if (viewMode === "edit" || overflowActions.length === 0) {
      return null
    }

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ArtifactAction
            data-testid="artifact-overflow-trigger"
            label={tCommon("more")}
            tooltip={tCommon("more")}
            icon={MoreHorizontal}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {overflowActions.map((action) => (
            <DropdownMenuItem key={action} onClick={() => handleOverflowAction(action)}>
              {getOverflowActionLabel(action)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const renderEditActions = () => (
    <>
      <Button
        size="sm"
        onClick={handleSaveEdit}
        disabled={!hasChanges}
        className="h-8 px-2 text-xs"
      >
        <Save className="h-4 w-4 mr-1" />
        {tCommon("save")}
      </Button>
      <Button size="sm" variant="ghost" onClick={handleCancelEdit} className="h-8 px-2 text-xs">
        <X className="h-4 w-4 mr-1" />
        {tCommon("cancel")}
      </Button>
    </>
  )

  const renderActionZone = () => {
    if (viewMode === "edit") {
      return renderEditActions()
    }

    return (
      <>
        {activeArtifact &&
          (viewMode === "code" || viewMode === "review" || viewMode === "split") && (
            <SelectionCommentButton artifact={activeArtifact} className="h-8 px-2 text-xs" />
          )}
        {primaryActions.map((action) => renderPrimaryAction(action))}
        {renderOverflowMenu()}
      </>
    )
  }

  const renderIdentityRow = () => {
    if (!activeArtifact) {
      return null
    }

    return (
      <div data-testid="artifact-header-row-identity" className="flex items-center gap-2 min-w-0">
        {getArtifactTypeIcon(activeArtifact.type)}
        <div className="min-w-0">
          <ArtifactTitle className="truncate">{activeArtifact.title}</ArtifactTitle>
          <span className="text-xs text-muted-foreground">{artifactMetadata}</span>
        </div>
        {pendingReview && (
          <span
            data-testid="artifact-review-badge"
            className="ml-1 shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          >
            {t("review.title")}
          </span>
        )}
      </div>
    )
  }

  const renderCode = () => (
    <ScrollArea className="h-full">
      <div className="p-4">
        <CodeBlock
          code={activeArtifact!.content}
          language={getShikiLanguage(activeArtifact!.language)}
          showLineNumbers
        />
      </div>
    </ScrollArea>
  )

  const renderContentBody = () => {
    if (!activeArtifact) return null
    if (viewMode === "review" && pendingReview) {
      return <ArtifactReviewView artifact={activeArtifact} panelMode={panelMode} />
    }
    if (viewMode === "edit") {
      return panelMode === "mobile" ? (
        <LightCodeEditor
          value={editContent}
          onChange={(v) => handleEditorChange(v)}
          language={editorLanguageFromMonacoId(
            getMonacoLanguage(activeArtifact.language || "plaintext")
          )}
          aria-label={activeArtifact.title}
          className="px-3"
        />
      ) : (
        <div className="flex h-full flex-col">
          <LspServerHint language={getMonacoLanguage(activeArtifact.language || "plaintext")} />
          <div className="min-h-0 flex-1">
            <MonacoEditor
              height="100%"
              language={getMonacoLanguage(activeArtifact.language || "plaintext")}
              theme={getMonacoTheme(theme)}
              value={editContent}
              onChange={handleEditorChange}
              onMount={(editor, monaco) => {
                workbenchHandleRef.current = mountMonacoWorkbench(
                  editor as unknown as IMonacoEditor,
                  monaco as unknown as MonacoNamespace,
                  {
                    surface: "artifact",
                    documentId: activeArtifact.id,
                    language: getMonacoLanguage(activeArtifact.language || "plaintext"),
                    initialContent: editContent,
                  }
                )
              }}
              options={{
                minimap: { enabled: isFullscreen },
                wordWrap: "on",
                readOnly: false,
                stickyScroll: { enabled: isFullscreen },
                bracketPairColorization: { enabled: true },
                guides: { indentation: true, bracketPairs: true },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                fontSize: 13,
              }}
            />
          </div>
        </div>
      )
    }
    if (viewMode === "split" && canSplit) {
      return (
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full"
          data-testid="artifact-split-view"
        >
          <ResizablePanel id="artifact-split-code" defaultSize="50%" minSize="25%">
            {renderCode()}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="artifact-split-preview" defaultSize="50%" minSize="25%">
            <ArtifactPreview artifact={activeArtifact} className="h-full" />
          </ResizablePanel>
        </ResizablePanelGroup>
      )
    }
    if (viewMode === "code" || !isPreviewable) {
      return renderCode()
    }
    return <ArtifactPreview artifact={activeArtifact} className="h-full" />
  }

  if (activeArtifact) {
    return (
      <>
        <Artifact className="h-full min-h-0 border-0 rounded-none">
          <ArtifactHeader className="flex-col items-stretch gap-2">
            {renderIdentityRow()}
            <PluginExtensionSlot
              point="artifact.toolbar"
              className="flex items-center gap-1 empty:hidden"
            />
            {panelMode !== "mobile" && (
              <ArtifactActions
                data-testid="artifact-header-row-actions"
                className="flex items-center gap-1 flex-wrap"
              >
                {renderActionZone()}
                <PluginExtensionSlot
                  point="artifact.actions"
                  className="flex items-center gap-1 empty:hidden"
                />
              </ArtifactActions>
            )}
          </ArtifactHeader>

          <ArtifactContent className="min-h-0 flex-1 overflow-hidden p-0">
            {renderContentBody()}
          </ArtifactContent>

          {showVersionHistory && (
            <PanelVersionHistory
              artifact={activeArtifact}
              onVersionRestored={() => setShowVersionHistory(false)}
            />
          )}

          {panelMode === "mobile" && (
            <div
              data-testid="artifact-mobile-footer"
              className="sticky bottom-0 border-t bg-background px-4 py-2 flex items-center gap-2"
            >
              <ArtifactActions className="flex items-center gap-1 flex-wrap">
                {renderActionZone()}
              </ArtifactActions>
            </div>
          )}
        </Artifact>

        {isDesignable && (
          <ArtifactDesignerWrapper
            artifact={activeArtifact}
            open={designerOpen}
            onOpenChange={setDesignerOpen}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("recentArtifacts")}</h3>
        <ArtifactClose data-testid="artifact-empty-close" onClick={closePanel} />
      </div>
      <ArtifactList className="flex-1" maxHeight="100%" />
    </div>
  )
}

export default ArtifactPanelContent
