"use client"

/**
 * ArtifactDock — the docked (non-modal) artifacts surface that lives in the
 * right rail of the chat workspace on desktop. Wraps the shared
 * `<ArtifactPanelContent />` with a slim header (collapse + history-rail
 * toggle) and an optional conversation-scoped artifact history rail.
 */

import { PanelRightClose, History } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { useChatStore } from "@/stores/chat"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { ArtifactPanelContent } from "./artifact-panel-content"
import { ArtifactList } from "./artifact-list"
import { DockWorkspace } from "./workspace-mode/dock-workspace"

export function ArtifactDock() {
  const t = useTranslations("artifacts")
  const listRailOpen = useArtifactDockLayoutStore((s) => s.listRailOpen)
  const toggleListRail = useArtifactDockLayoutStore((s) => s.toggleListRail)
  const setDockCollapsed = useArtifactDockLayoutStore((s) => s.setDockCollapsed)
  const dockMode = useArtifactDockLayoutStore((s) => s.dockMode)
  const setDockMode = useArtifactDockLayoutStore((s) => s.setDockMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const workspaceAvailable = hasWorkspaceFsBackend()

  return (
    <div
      data-testid="artifact-dock"
      className="flex h-full min-h-0 flex-col border-l bg-background"
    >
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1">
        <div className="flex items-center rounded-md bg-muted p-0.5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={dockMode === "artifact"}
            data-testid="artifact-dock-mode-artifact"
            className={cn(
              "rounded px-2 py-1 text-xs",
              dockMode === "artifact" ? "bg-background shadow-sm" : "text-muted-foreground"
            )}
            onClick={() => setDockMode("artifact")}
          >
            {t("dock.artifactMode")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={dockMode === "workspace"}
            data-testid="artifact-dock-mode-workspace"
            disabled={!workspaceAvailable}
            title={!workspaceAvailable ? t("dock.workspaceUnavailable") : undefined}
            className={cn(
              "rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50",
              dockMode === "workspace" ? "bg-background shadow-sm" : "text-muted-foreground"
            )}
            onClick={() => setDockMode("workspace")}
          >
            {t("dock.workspaceMode")}
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <TooltipProvider>
            {dockMode === "artifact" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="artifact-dock-history-toggle"
                    variant={listRailOpen ? "secondary" : "ghost"}
                    size="icon"
                    className="h-7 w-7"
                    aria-pressed={listRailOpen}
                    aria-label={listRailOpen ? t("dock.hideHistory") : t("dock.showHistory")}
                    onClick={toggleListRail}
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {listRailOpen ? t("dock.hideHistory") : t("dock.showHistory")}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="artifact-dock-collapse"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("dock.collapse")}
                  title={t("dock.toggleHint")}
                  onClick={() => setDockCollapsed(true)}
                >
                  <PanelRightClose className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("dock.toggleHint")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {dockMode === "artifact" && listRailOpen && (
          <div
            data-testid="artifact-dock-history-rail"
            className={cn("w-56 shrink-0 border-r overflow-hidden")}
          >
            <ArtifactList
              sessionId={activeSessionId ?? undefined}
              className="h-full"
              maxHeight="100%"
            />
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {dockMode === "artifact" ? (
            <ArtifactPanelContent panelMode="desktop" />
          ) : (
            <DockWorkspace activeSessionId={activeSessionId} />
          )}
        </div>
      </div>
    </div>
  )
}

export default ArtifactDock
