"use client"

/**
 * A2UI Workspace
 * Three-panel editing workspace for A2UI mini-apps
 * Chrome: one `FeaturePageHeader` (identity + mode tabs) whose secondary band
 *   is the toolbar — previously two independently styled bars
 * Desktop: Resizable panels (tree | preview | properties)
 * Mobile: Tab-based bottom nav with Sheet overlays
 */

import React, { useCallback } from "react"
import { useTranslations } from "next-intl"
import { TreePine, Eye, Settings2, Database, History } from "lucide-react"
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
import { VersionHistoryPanel } from "./version-history-panel"
import { A2UIErrorPanel } from "./a2ui-error-panel"
import { useA2UIWorkspaceShortcuts } from "@/hooks/a2ui/use-a2ui-workspace-shortcuts"
import { useA2UISave } from "@/hooks/a2ui/use-a2ui-save"
import { useA2UIStore } from "@/stores/a2ui"
import {
  canDuplicateComponentSubtree,
  type A2UIComponentPlacement,
} from "@/lib/a2ui/component-tree"
import {
  createA2UIComponentBundle,
  createAvailableComponentId,
} from "@/lib/a2ui/component-definitions"
import { toast } from "sonner"

interface A2UIWorkspaceProps {
  surfaceId: string
  className?: string
}

function WorkspacePreview({
  surfaceId,
  compact = false,
}: {
  surfaceId: string
  compact?: boolean
}) {
  const { zoom } = useWorkspaceContext()
  const scale = zoom / 100

  return (
    <div className={cn("h-full overflow-auto bg-muted/20", compact ? "p-3" : "p-4")}>
      <div
        data-testid="workspace-preview-scale"
        className="origin-top-left transition-transform duration-200 motion-reduce:transition-none"
        style={{
          transform: `scale(${scale})`,
          width: `${100 / scale}%`,
        }}
      >
        <A2UIInlineSurface
          surfaceId={surfaceId}
          className={compact ? undefined : "min-h-[200px]"}
        />
      </div>
    </div>
  )
}

function WorkspaceContent() {
  const t = useTranslations("a2ui")
  const {
    surfaceId,
    workspaceMode,
    setWorkspaceMode,
    showTree,
    showProperties,
    selectedComponentId,
    setSelectedComponentId,
  } = useWorkspaceContext()
  const [mobileTab, setMobileTab] = React.useState<string>("preview")
  const saveApp = useA2UISave(surfaceId)
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const removeComponent = useA2UIStore((state) => state.removeComponent)
  const duplicateComponent = useA2UIStore((state) => state.duplicateComponent)
  const addComponentSubtree = useA2UIStore((state) => state.addComponentSubtree)
  const addComponentSubtreeToRoot = useA2UIStore((state) => state.addComponentSubtreeToRoot)
  const moveComponent = useA2UIStore((state) => state.moveComponent)

  const canDeleteSelected = Boolean(
    selectedComponentId && surface && selectedComponentId !== surface.rootId
  )
  const canDuplicateSelected = React.useMemo(
    () =>
      Boolean(
        selectedComponentId &&
        surface &&
        canDuplicateComponentSubtree(surface.components, surface.rootId, selectedComponentId)
      ),
    [selectedComponentId, surface]
  )

  const handleSave = useCallback(async () => {
    try {
      const ok = await saveApp()
      if (ok) toast.success(t("appSaved"))
      else toast.error(t("generationFailed"))
    } catch {
      toast.error(t("generationFailed"))
    }
  }, [saveApp, t])

  const handleDeselect = useCallback(() => {
    setSelectedComponentId(null)
  }, [setSelectedComponentId])

  const handleToggleMode = useCallback(() => {
    setWorkspaceMode(workspaceMode === "edit" ? "preview" : "edit")
  }, [workspaceMode, setWorkspaceMode])

  const handleDeleteComponent = useCallback(() => {
    if (!selectedComponentId) return
    if (removeComponent(surfaceId, selectedComponentId)) {
      setSelectedComponentId(null)
    }
  }, [removeComponent, selectedComponentId, setSelectedComponentId, surfaceId])

  const handleDuplicateComponent = useCallback(() => {
    if (!selectedComponentId) return
    const duplicateId = duplicateComponent(surfaceId, selectedComponentId)
    if (duplicateId) setSelectedComponentId(duplicateId)
  }, [duplicateComponent, selectedComponentId, setSelectedComponentId, surfaceId])

  const handleAddComponent = useCallback(
    (type: string, placement: A2UIComponentPlacement) => {
      if (!surface) return false
      const id = createAvailableComponentId(type, new Set(Object.keys(surface.components)))
      const bundle = createA2UIComponentBundle(type, id)
      const added = addComponentSubtree(surfaceId, bundle.components, bundle.rootId, placement)
      if (added) setSelectedComponentId(bundle.rootId)
      return added
    },
    [addComponentSubtree, setSelectedComponentId, surface, surfaceId]
  )

  const handleMoveComponent = useCallback(
    (placement: A2UIComponentPlacement) => {
      if (!selectedComponentId) return false
      return moveComponent(surfaceId, selectedComponentId, placement)
    },
    [moveComponent, selectedComponentId, surfaceId]
  )

  const handleAddComponentToRoot = useCallback(
    (type: string) => {
      if (!surface) return false
      const id = createAvailableComponentId(type, new Set(Object.keys(surface.components)))
      const bundle = createA2UIComponentBundle(type, id)
      const added = addComponentSubtreeToRoot(surfaceId, bundle.components, bundle.rootId)
      if (added) setSelectedComponentId(bundle.rootId)
      return added
    },
    [addComponentSubtreeToRoot, setSelectedComponentId, surface, surfaceId]
  )

  useA2UIWorkspaceShortcuts({
    surfaceId,
    onSave: handleSave,
    onDeselect: handleDeselect,
    onToggleMode: handleToggleMode,
    onDeleteComponent: handleDeleteComponent,
    onDuplicateComponent: handleDuplicateComponent,
  })

  const componentTree = (
    <ComponentTreePanel
      canDeleteSelected={canDeleteSelected}
      canDuplicateSelected={canDuplicateSelected}
      onDeleteSelected={handleDeleteComponent}
      onDuplicateSelected={handleDuplicateComponent}
      onAddComponent={handleAddComponent}
      onAddComponentToRoot={handleAddComponentToRoot}
      onMoveSelected={handleMoveComponent}
    />
  )

  // Desktop layout
  const desktopLayout = (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
      {/* Left: Component Tree */}
      {showTree && workspaceMode === "edit" && (
        <>
          <ResizablePanel defaultSize="20%" minSize="15%" maxSize="35%">
            {componentTree}
          </ResizablePanel>
          <ResizableHandle withHandle />
        </>
      )}

      {/* Center: Preview */}
      <ResizablePanel defaultSize={workspaceMode === "data" ? "50%" : "60%"} minSize="30%">
        <WorkspacePreview surfaceId={surfaceId} />
      </ResizablePanel>

      {/* Right: Property Inspector or Data Model */}
      {workspaceMode === "edit" && showProperties && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="25%" minSize="15%" maxSize="40%">
            <Tabs defaultValue="properties" className="h-full gap-0">
              <TabsList className="grid h-9 w-full grid-cols-2 rounded-none border-b">
                <TabsTrigger value="properties">{t("propertyInspector")}</TabsTrigger>
                <TabsTrigger value="history">{t("versionHistory")}</TabsTrigger>
              </TabsList>
              <TabsContent value="properties" className="mt-0 min-h-0 flex-1">
                <PropertyInspectorPanel />
              </TabsContent>
              <TabsContent value="history" className="mt-0 min-h-0 flex-1">
                <VersionHistoryPanel />
              </TabsContent>
            </Tabs>
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
          <WorkspacePreview surfaceId={surfaceId} compact />
        </TabsContent>
        <TabsContent value="tree" className="h-full m-0 data-[state=inactive]:hidden">
          {componentTree}
        </TabsContent>
        <TabsContent value="properties" className="h-full m-0 data-[state=inactive]:hidden">
          <PropertyInspectorPanel />
        </TabsContent>
        <TabsContent value="data" className="h-full m-0 data-[state=inactive]:hidden">
          <DataModelPanel />
        </TabsContent>
        <TabsContent value="history" className="h-full m-0 data-[state=inactive]:hidden">
          <VersionHistoryPanel />
        </TabsContent>
      </div>

      <TabsList className="grid grid-cols-5 h-14 rounded-none border-t bg-background/95 backdrop-blur shrink-0">
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
        <TabsTrigger
          value="history"
          className="flex flex-col gap-0.5 data-[state=active]:bg-accent/50"
        >
          <History className="h-4 w-4" />
          <span className="text-[10px]">{t("versionHistory")}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )

  return (
    <div className="flex flex-col h-full">
      {/* One chrome element, not two stacked bars: the toolbar renders as the
          header's secondary band (see `a2ui-workspace-header.tsx`). */}
      <WorkspaceHeader controls={<A2UIToolbar />} />
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
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <WorkspaceContent />
      </div>
    </A2UIWorkspaceProvider>
  )
}
