"use client"

/**
 * ArtifactPanel - Side panel for displaying and managing artifacts.
 *
 * cognia-next adapts upstream Cognia by:
 *  - Inlining a small Monaco language/theme helper (no `@/lib/monaco`)
 *  - Dropping the Designer-specific overflow actions
 *  - Dropping the editor-workbench V2 Monaco-context binding
 */

import dynamic from "next/dynamic"
import { Maximize2, Minimize2, MoreHorizontal, Pencil, Save, X, FileCode } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

// Dynamically import Monaco to avoid SSR issues
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

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { PanelVersionHistory } from "./panel-version-history"
import { ArtifactDesignerWrapper } from "./panel-designer-wrapper"
import {
  DESIGNABLE_TYPES,
  getMonacoLanguage,
  getShikiLanguage,
  MERMAID_TYPE_NAMES,
} from "@/lib/artifacts"
import { getArtifactTypeIcon } from "./artifact-icons"
import { useArtifactPanelState } from "@/hooks/artifacts/use-artifact-panel"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

type ArtifactPanelAction =
  | "modeTabs"
  | "edit"
  | "canvas"
  | "fullscreen"
  | "close"
  | "copy"
  | "download"
  | "revealInExplorer"
  | "versionHistory"

function getMonacoTheme(theme?: string): string {
  return theme === "dark" ? "vs-dark" : "vs"
}

export function ArtifactPanel() {
  const {
    t,
    tCommon,
    panelOpen,
    panelView,
    activeArtifact,
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
    panelMode,
    panelWidth,
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
    handleRevealInExplorer,
  } = useArtifactPanelState()

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
    <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as "code" | "preview")}>
      <TabsList className="h-8">
        <TabsTrigger data-testid="artifact-tab-code" value="code" className="text-xs px-2">
          {t("code")}
        </TabsTrigger>
        {isPreviewable && (
          <TabsTrigger data-testid="artifact-tab-preview" value="preview" className="text-xs px-2">
            {t("preview")}
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
      </div>
    )
  }

  return (
    <Sheet
      open={panelOpen && panelView === "artifact"}
      onOpenChange={(open) => !open && closePanel()}
    >
      <SheetContent
        side={panelMode === "mobile" ? "bottom" : "right"}
        className={`${panelWidth} p-0 transition-all duration-200 ${
          panelMode === "mobile" ? "pb-[env(safe-area-inset-bottom)]" : ""
        }`}
        data-testid="artifact-panel"
      >
        <SheetTitle className="sr-only">{t("sheetTitle")}</SheetTitle>
        {activeArtifact ? (
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
              {viewMode === "edit" ? (
                <MonacoEditor
                  height="100%"
                  language={getMonacoLanguage(activeArtifact.language || "plaintext")}
                  theme={getMonacoTheme(theme)}
                  value={editContent}
                  onChange={handleEditorChange}
                  options={{
                    minimap: { enabled: isFullscreen },
                    wordWrap: "on",
                    readOnly: false,
                    stickyScroll: { enabled: isFullscreen },
                    bracketPairColorization: { enabled: true },
                    guides: {
                      indentation: true,
                      bracketPairs: true,
                    },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    fontSize: 13,
                  }}
                />
              ) : viewMode === "code" || !isPreviewable ? (
                <ScrollArea className="h-full">
                  <div className="p-4">
                    <CodeBlock
                      code={activeArtifact.content}
                      language={getShikiLanguage(activeArtifact.language)}
                      showLineNumbers
                    />
                  </div>
                </ScrollArea>
              ) : (
                <ArtifactPreview artifact={activeArtifact} className="h-full" />
              )}
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
        ) : (
          <div className="flex flex-col h-full">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="text-sm font-medium">{t("recentArtifacts")}</h3>
              <ArtifactClose data-testid="artifact-empty-close" onClick={closePanel} />
            </div>
            <ArtifactList className="flex-1" maxHeight="100%" />
          </div>
        )}

        {activeArtifact && isDesignable && (
          <ArtifactDesignerWrapper
            artifact={activeArtifact}
            open={designerOpen}
            onOpenChange={setDesignerOpen}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
