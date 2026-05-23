"use client"

/**
 * A2UI Workspace
 * Three-panel editing workspace for A2UI mini-apps
 * Desktop: Resizable panels (tree | preview | properties)
 * Mobile: Tab-based bottom nav with Sheet overlays
 */

import React, { useCallback } from "react"
import { useTranslations } from "next-intl"
import { TreePine, Eye, Settings2, Database } from "lucide-react"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { A2UIInlineSurface } from "@/components/a2ui/a2ui-surface"
import { cn } from "@/lib/utils"
import { A2UIWorkspaceProvider, useWorkspaceContext } from "./a2ui-workspace-context"
import { WorkspaceHeader } from "./a2ui-workspace-header"
import { A2UIToolbar } from "./a2ui-toolbar"
import { ComponentTreePanel } from "./component-tree-panel"
import { PropertyInspectorPanel } from "./property-inspector-panel"
import { DataModelPanel } from "./data-model-panel"
import { A2UIErrorPanel } from "./a2ui-error-panel"
import { useA2UIWorkspaceShortcuts } from "@/hooks/a2ui/use-a2ui-workspace-shortcuts"
import { toast } from "sonner"

interface A2UIWorkspaceProps {
  surfaceId: string
  className?: string
}

function WorkspaceContent() {
  const t = useTranslations("a2ui")
  const {
    surfaceId,
    workspaceMode,
    setWorkspaceMode,
    showTree,
    showProperties,
    setSelectedComponentId,
  } = useWorkspaceContext()
  const [mobileTab, setMobileTab] = React.useState<string>("preview")

  const handleSave = useCallback(() => {
    toast.success(t("appSaved"))
  }, [t])

  const handleDeselect = useCallback(() => {
    setSelectedComponentId(null)
  }, [setSelectedComponentId])

  const handleToggleMode = useCallback(() => {
    setWorkspaceMode(workspaceMode === "edit" ? "preview" : "edit")
  }, [workspaceMode, setWorkspaceMode])

  useA2UIWorkspaceShortcuts({
    surfaceId,
    onSave: handleSave,
    onDeselect: handleDeselect,
    onToggleMode: handleToggleMode,
  })

  // Desktop layout
  const desktopLayout = (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
      {/* Left: Component Tree */}
      {showTree && workspaceMode === "edit" && (
        <>
          <ResizablePanel defaultSize="20%" minSize="15%" maxSize="35%">
            <ComponentTreePanel />
          </ResizablePanel>
          <ResizableHandle withHandle />
        </>
      )}

      {/* Center: Preview */}
      <ResizablePanel defaultSize={workspaceMode === "data" ? "50%" : "60%"} minSize="30%">
        <div className="h-full overflow-auto p-4 bg-muted/20">
          <A2UIInlineSurface surfaceId={surfaceId} className="min-h-[200px]" />
        </div>
      </ResizablePanel>

      {/* Right: Property Inspector or Data Model */}
      {workspaceMode === "edit" && showProperties && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="25%" minSize="15%" maxSize="40%">
            <PropertyInspectorPanel />
          </ResizablePanel>
        </>
      )}

      {workspaceMode === "data" && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="50%" minSize="25%" maxSize="70%">
            <DataModelPanel />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  )

  // Mobile layout: Tab-based with bottom nav
  const mobileLayout = (
    <Tabs value={mobileTab} onValueChange={setMobileTab} className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-hidden">
        <TabsContent value="preview" className="h-full m-0 data-[state=inactive]:hidden">
          <div className="h-full overflow-auto p-3 bg-muted/20">
            <A2UIInlineSurface surfaceId={surfaceId} />
          </div>
        </TabsContent>
        <TabsContent value="tree" className="h-full m-0 data-[state=inactive]:hidden">
          <ComponentTreePanel />
        </TabsContent>
        <TabsContent value="properties" className="h-full m-0 data-[state=inactive]:hidden">
          <PropertyInspectorPanel />
        </TabsContent>
        <TabsContent value="data" className="h-full m-0 data-[state=inactive]:hidden">
          <DataModelPanel />
        </TabsContent>
      </div>

      <TabsList className="grid grid-cols-4 h-14 rounded-none border-t bg-background/95 backdrop-blur shrink-0">
        <TabsTrigger
          value="preview"
          className="flex flex-col gap-0.5 data-[state=active]:bg-accent/50"
        >
          <Eye className="h-4 w-4" />
          <span className="text-[10px]">{t("previewMode")}</span>
        </TabsTrigger>
        <TabsTrigger
          value="tree"
          className="flex flex-col gap-0.5 data-[state=active]:bg-accent/50"
        >
          <TreePine className="h-4 w-4" />
          <span className="text-[10px]">{t("componentTree")}</span>
        </TabsTrigger>
        <TabsTrigger
          value="properties"
          className="flex flex-col gap-0.5 data-[state=active]:bg-accent/50"
        >
          <Settings2 className="h-4 w-4" />
          <span className="text-[10px]">{t("propertyInspector")}</span>
        </TabsTrigger>
        <TabsTrigger
          value="data"
          className="flex flex-col gap-0.5 data-[state=active]:bg-accent/50"
        >
          <Database className="h-4 w-4" />
          <span className="text-[10px]">{t("dataMode")}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <div className="flex flex-col h-full">
      <WorkspaceHeader />
      <A2UIToolbar />
      {/* Desktop */}
      <div className="flex-1 min-h-0 hidden sm:flex">{desktopLayout}</div>
      {/* Mobile */}
      <div className="flex-1 min-h-0 flex sm:hidden">{mobileLayout}</div>
      {/* Error panel */}
      <A2UIErrorPanel />
    </div>
  )
}

export function A2UIWorkspace({ surfaceId, className }: A2UIWorkspaceProps) {
  return (
    <A2UIWorkspaceProvider surfaceId={surfaceId}>
      <div className={cn("h-full", className)}>
        <WorkspaceContent />
      </div>
    </A2UIWorkspaceProvider>
  )
}
