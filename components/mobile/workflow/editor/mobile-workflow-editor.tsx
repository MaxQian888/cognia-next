"use client"

/**
 * Mobile workflow editor — the touch-first counterpart to the desktop
 * `WorkflowEditorCanvas`. It mounts the *same* per-workflow editor store
 * (createEditorStore + providers) and reuses the node/edge renderers,
 * inspector, catalog, and persist path; only the chrome is mobile-specific:
 *
 *   • a slim top bar (back / name / read·edit toggle / Save / Run / overflow)
 *   • a FAB that opens the node palette as a bottom sheet (edit mode)
 *   • a Vaul snap drawer hosting the node inspector
 *   • tap-to-connect instead of drag-from-handle
 *
 * Read mode is the default so panning around to read a flow never moves a
 * node by accident; the Edit toggle unlocks structural editing.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { ReactFlowProvider } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { X as CancelIcon, Maximize2 as FitViewIcon, Trash2 as TrashIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { FloatingActionButton } from "@/components/ui/floating-action-button"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import type { VisualWorkflow } from "@/types/workflow/visual"

import { MobileCanvas, type WorkflowFlowInstance } from "./mobile-canvas"
import { MobileEditorTopbar } from "./mobile-editor-topbar"
import { MobileNodePaletteSheet } from "./mobile-node-palette-sheet"
import { MobileNodeInspectorDrawer } from "./mobile-node-inspector-drawer"
import { MobileWorkflowCopilotSheet } from "./mobile-workflow-copilot-sheet"
import { useTapConnect } from "./use-tap-connect"

function MobileEditorInner({ store }: { store: EditorStore }) {
  const t = useTranslations("mobile.workflow.editor")
  const tConnection = useTranslations("workflows.editor.connection")
  const [mode, setMode] = useState<"read" | "edit">("read")
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [copilotOpen, setCopilotOpen] = useState(false)
  const [rf, setRf] = useState<WorkflowFlowInstance | null>(null)
  const canvasAreaRef = useRef<HTMLDivElement | null>(null)
  const tapConnect = useTapConnect(store)
  const selectedId = store((s) => s.selectedNodeIds[0] ?? null)
  const selectedEdgeId = store((s) => s.selectedEdgeIds[0] ?? null)
  const workflowId = store((s) => s.baseWorkflow.id)
  const workflowName = store((s) => s.baseWorkflow.name)

  // `touchConnect` arms the shared node renderer's tap-to-connect entry: tapping
  // a source handle starts a connection. It's an edit-mode affordance only, and
  // must clear when the editor unmounts so a desktop store (shared renderer)
  // never inherits it.
  useEffect(() => {
    store.getState().setTouchConnect(mode === "edit")
    return () => {
      store.getState().setTouchConnect(false)
    }
  }, [mode, store])

  const onToggleMode = useCallback(() => {
    const next = mode === "edit" ? "read" : "edit"
    if (next === "read") {
      tapConnect.cancel()
      setPaletteOpen(false)
    }
    setMode(next)
  }, [mode, tapConnect])

  const onNodeTap = useCallback(
    (id: string) => {
      if (tapConnect.active) {
        const result = tapConnect.completeTo(id)
        if (!result.valid) toast.error(tConnection(result.reasonKey))
        return
      }
      store.getState().setSelectedNodes([id])
      setInspectorOpen(true)
    },
    [store, tapConnect, tConnection]
  )

  const onEdgeTap = useCallback(
    (id: string) => {
      if (mode !== "edit") return
      if (tapConnect.active) {
        tapConnect.cancel()
        return
      }
      // Select just the edge (clears any node selection + closes the inspector)
      // so the floating delete bar acts on it.
      store.getState().clearSelection()
      store.getState().setSelectedEdges([id])
      setInspectorOpen(false)
    },
    [mode, store, tapConnect]
  )

  const onPaneTap = useCallback(() => {
    if (tapConnect.active) {
      tapConnect.cancel()
      return
    }
    store.getState().clearSelection()
    setInspectorOpen(false)
  }, [store, tapConnect])

  const onDeleteEdge = useCallback(() => {
    if (!selectedEdgeId) return
    store.getState().removeEdges([selectedEdgeId])
    store.getState().clearSelection()
  }, [selectedEdgeId, store])

  const addAtCenter = useCallback(
    (entry: NodeCatalogEntry) => {
      let position = { x: 80, y: 80 }
      if (rf) {
        const rect = canvasAreaRef.current?.getBoundingClientRect()
        const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
        const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
        position = rf.screenToFlowPosition({ x: cx, y: cy })
      }
      const id = store.getState().addNode(entry.kind, position)
      store.getState().setSelectedNodes([id])
      setPaletteOpen(false)
      setInspectorOpen(true)
    },
    [rf, store]
  )

  const onStartConnect = useCallback(() => {
    if (!selectedId) return
    setInspectorOpen(false)
    tapConnect.start(selectedId)
  }, [selectedId, tapConnect])

  const onInspectorOpenChange = useCallback(
    (open: boolean) => {
      // Only user-initiated dismiss (swipe / overlay) lands here — clear the
      // selection so reopening always reflects a fresh tap.
      if (!open) {
        setInspectorOpen(false)
        store.getState().clearSelection()
      }
    },
    [store]
  )

  return (
    <div className="flex h-full w-full flex-col" data-testid="mobile-workflow-editor">
      <MobileEditorTopbar
        store={store}
        reactFlowInstance={rf}
        mode={mode}
        onToggleMode={onToggleMode}
        onOpenCopilot={() => setCopilotOpen(true)}
      />
      <div ref={canvasAreaRef} className="relative min-h-0 flex-1">
        <MobileCanvas
          store={store}
          mode={mode}
          connectActive={tapConnect.active}
          onNodeTap={onNodeTap}
          onEdgeTap={onEdgeTap}
          onPaneTap={onPaneTap}
          onInit={setRf}
        />
        {mode === "edit" && !tapConnect.active ? (
          <FloatingActionButton
            position="absolute"
            aria-label={t("addNode")}
            onClick={() => setPaletteOpen(true)}
            data-testid="mobile-editor-fab"
          />
        ) : null}
        {!tapConnect.active ? (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-4 z-20 size-11 rounded-full shadow-lg"
            onClick={() => rf?.fitView({ duration: 240, padding: 0.2 })}
            aria-label={t("fitView")}
            data-testid="mobile-editor-recenter"
          >
            <FitViewIcon className="size-5" aria-hidden="true" />
          </Button>
        ) : null}
        {tapConnect.active ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-1/2 z-30 min-h-11 -translate-x-1/2 shadow-lg"
            onClick={() => tapConnect.cancel()}
            data-testid="mobile-connect-cancel"
          >
            <CancelIcon className="mr-1 size-4" aria-hidden="true" />
            {t("cancelConnect")}
          </Button>
        ) : null}
        {mode === "edit" && selectedEdgeId && !tapConnect.active ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-1/2 z-30 min-h-11 -translate-x-1/2 shadow-lg"
            onClick={onDeleteEdge}
            data-testid="mobile-edge-delete"
          >
            <TrashIcon className="mr-1 size-4" aria-hidden="true" />
            {t("deleteConnection")}
          </Button>
        ) : null}
      </div>
      <MobileNodePaletteSheet open={paletteOpen} onOpenChange={setPaletteOpen} onAdd={addAtCenter} />
      <MobileNodeInspectorDrawer
        open={inspectorOpen && selectedId != null}
        onOpenChange={onInspectorOpenChange}
        store={store}
        canConnect={mode === "edit"}
        onStartConnect={onStartConnect}
      />
      <MobileWorkflowCopilotSheet
        open={copilotOpen}
        onOpenChange={setCopilotOpen}
        store={store}
        workflowId={workflowId}
        workflowName={workflowName}
      />
    </div>
  )
}

export interface MobileWorkflowEditorProps {
  workflow: VisualWorkflow
}

export function MobileWorkflowEditor({ workflow }: MobileWorkflowEditorProps) {
  // One store per (component instance × workflow id) — mirrors the desktop
  // canvas so navigating between workflows rebuilds the store + history.
  const [store, setStore] = useState<EditorStore>(() => createEditorStore(workflow))
  const [storedWorkflowId, setStoredWorkflowId] = useState(workflow.id)
  if (storedWorkflowId !== workflow.id) {
    setStoredWorkflowId(workflow.id)
    setStore(createEditorStore(workflow))
  }

  return (
    <ReactFlowProvider>
      <EditorStoreProvider store={store}>
        <MobileEditorInner store={store} />
      </EditorStoreProvider>
    </ReactFlowProvider>
  )
}
