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
import { ReactFlowProvider, type ReactFlowInstance } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { X as CancelIcon, Maximize2 as FitViewIcon, Trash2 as TrashIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { FloatingActionButton } from "@/components/ui/floating-action-button"
import { RightSidebar } from "@/components/workflow/editor/right-sidebar"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import type { VisualWorkflow } from "@/types/workflow/visual"

import {
  buildClipboardEnvelope,
  parseClipboard,
  serializeClipboard,
} from "@/lib/workflow/editor/clipboard"

import { SelectionToolbar } from "@/components/workflow/editor/selection-toolbar"
import { Surface } from "@/components/surface/surface"

import { MobileCanvas, type MobileCanvasMode, type WorkflowFlowInstance } from "./mobile-canvas"
import { MobileCanvasActionSheet } from "./mobile-canvas-action-sheet"
import type { CanvasPressTarget } from "./use-canvas-long-press"
import { MobileEditorTopbar } from "./mobile-editor-topbar"
import { MobileNodePaletteSheet } from "./mobile-node-palette-sheet"
import { MobileNodeSearchSheet } from "./mobile-node-search-sheet"
import { MobileNodeInspectorDrawer } from "./mobile-node-inspector-drawer"
import { MobileWorkflowCopilotSheet } from "./mobile-workflow-copilot-sheet"
import { useTapConnect } from "./use-tap-connect"

function MobileEditorInner({ store }: { store: EditorStore }) {
  const t = useTranslations("mobile.workflow.editor")
  const tWorkflow = useTranslations("mobile.workflow")
  const tConnection = useTranslations("workflows.editor.connection")
  const portrait = usePortraitOrientation()
  const [mode, setMode] = useState<MobileCanvasMode>("read")
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [copilotOpen, setCopilotOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [pressTarget, setPressTarget] = useState<CanvasPressTarget | null>(null)
  const [canPaste, setCanPaste] = useState(false)
  // Landscape is the editor's default, not a rule imposed on the user.
  const [orientationLocked, setOrientationLocked] = useState(true)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
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
    const next = mode === "read" ? "edit" : "read"
    if (next === "read") {
      tapConnect.cancel()
      setPaletteOpen(false)
      store.getState().clearSelection()
    }
    setMode(next)
  }, [mode, store, tapConnect])

  /**
   * Marquee select is a sub-mode of edit, not a third top-level one: dragging
   * empty space is how you pan, so the two cannot both own the same gesture.
   */
  const onToggleSelectMode = useCallback(() => {
    setMode((current) => {
      if (current === "select") return "edit"
      tapConnect.cancel()
      setInspectorOpen(false)
      return "select"
    })
  }, [tapConnect])

  const onNodeTap = useCallback(
    (id: string) => {
      if (tapConnect.active) {
        const result = tapConnect.completeTo(id)
        if (!result.valid) toast.error(tConnection(result.reasonKey))
        return
      }
      if (mode === "select") {
        const current = store.getState().selectedNodeIds
        store
          .getState()
          .setSelectedNodes(
            current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
          )
        return
      }
      store.getState().setSelectedNodes([id])
      setInspectorOpen(true)
    },
    [mode, store, tapConnect, tConnection]
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

  /**
   * Long press opens the action sheet. The clipboard is probed here rather than
   * inside the sheet because reading it is async and permission-gated: a
   * "Paste" row that appears a beat late, or appears and then fails, is worse
   * than one that is simply absent.
   */
  const onLongPress = useCallback(
    (target: CanvasPressTarget) => {
      if (tapConnect.active) return
      if (target.kind === "pane") {
        void navigator.clipboard
          ?.readText()
          .then((text) => setCanPaste(parseClipboard(text) !== null))
          .catch(() => setCanPaste(false))
      }
      setPressTarget(target)
    },
    [tapConnect]
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
        onOpenSearch={() => setSearchOpen(true)}
        onToggleSelectMode={onToggleSelectMode}
        orientationLocked={orientationLocked}
        onToggleOrientationLock={() => setOrientationLocked((v) => !v)}
        onOpenWorkbench={() => setWorkbenchOpen(true)}
      />
      <div ref={canvasAreaRef} className="relative min-h-0 flex-1">
        <MobileCanvas
          store={store}
          mode={mode}
          connectActive={tapConnect.active}
          onNodeTap={onNodeTap}
          onEdgeTap={onEdgeTap}
          onPaneTap={onPaneTap}
          onLongPress={onLongPress}
          orientationLocked={orientationLocked}
          onInit={setRf}
        />
        {/* The graph reads badly in a 360-px portrait column. With the lock
            released the OS follows the device, so a phone held upright gets
            the narrow view. This says so, once, and tapping it re-locks. The
            copy existed since the lock shipped and was rendered by nothing. */}
        {!orientationLocked && portrait ? (
          <Surface asChild layer="overlay" elevation={1}>
            <button
              type="button"
              onClick={() => setOrientationLocked(true)}
              className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-pill border px-3 py-1 text-xs text-muted-foreground backdrop-blur"
              data-testid="mobile-editor-landscape-hint"
            >
              {tWorkflow("landscapeHint")}
            </button>
          </Surface>
        ) : null}
        {/* The desktop selection toolbar, in its touch layout. Duplicating its
            duplicate / group / align / distribute / delete / extract handlers
            for the phone would have been six more places to keep in step. */}
        {mode === "select" && !tapConnect.active ? (
          <SelectionToolbar
            store={store}
            // `WorkflowFlowInstance` is the same instance narrowed to this
            // editor's node/edge shapes; the toolbar only calls fitBounds.
            reactFlowInstance={rf as ReactFlowInstance | null}
            motionEnabled={false}
            touch
          />
        ) : null}
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
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-4 z-20 size-11 rounded-full"
            data-elevation="3"
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
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-1/2 z-30 min-h-11 -translate-x-1/2"
            data-elevation="3"
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
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-1/2 z-30 min-h-11 -translate-x-1/2"
            data-elevation="3"
            onClick={onDeleteEdge}
            data-testid="mobile-edge-delete"
          >
            <TrashIcon className="mr-1 size-4" aria-hidden="true" />
            {t("deleteConnection")}
          </Button>
        ) : null}
      </div>
      <MobileCanvasActionSheet
        target={pressTarget}
        onOpenChange={(open) => (open ? undefined : setPressTarget(null))}
        canPaste={canPaste}
        onAddNode={() => setPaletteOpen(true)}
        onConfigure={(id) => {
          store.getState().setSelectedNodes([id])
          setInspectorOpen(true)
        }}
        onDuplicate={(id) => {
          const created = store.getState().duplicateNodes([id])
          if (created.length > 0) store.getState().setSelectedNodes(created)
        }}
        onCopy={(id) => {
          const node = store.getState().nodes.find((n) => n.id === id)
          if (!node) return
          void navigator.clipboard
            ?.writeText(serializeClipboard(buildClipboardEnvelope([node], [], [node.id])))
            .catch(() => {})
        }}
        onPaste={() => {
          void navigator.clipboard
            ?.readText()
            .then((text) => {
              const envelope = parseClipboard(text)
              if (envelope) store.getState().pasteFromEnvelope(envelope)
            })
            .catch(() => {})
        }}
        onRunFrom={(id) => store.getState().requestRunFromStep(id)}
        onRunOnly={(id) => store.getState().requestRunSingleStep(id)}
        onDeleteNode={(id) => {
          store.getState().removeNodes([id])
          store.getState().clearSelection()
          setInspectorOpen(false)
        }}
        onDeleteEdge={(id) => {
          store.getState().removeEdges([id])
          store.getState().clearSelection()
        }}
        onFitView={() => rf?.fitView({ duration: 240, padding: 0.2 })}
        onFindNode={() => setSearchOpen(true)}
      />
      <MobileNodePaletteSheet open={paletteOpen} onOpenChange={setPaletteOpen} onAdd={addAtCenter} />
      {/* Revealing a node centres, selects and pulses it. Opening the inspector
          on top of that would bury the node the user just went looking for, so
          the sheet closes onto the canvas and the pulse is the confirmation. */}
      <MobileNodeSearchSheet
        open={searchOpen}
        onOpenChange={setSearchOpen}
        store={store}
        reactFlowInstance={rf}
      />
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
      {/* The shared Context Workbench drawer, same as the artifact dock and the
          project editor. This used to be a hand-rolled right-edge `<Sheet>`,
          which is how the workflow editor ended up the one host without the
          drawer's snap points, back-dismiss and keyboard inset. */}
      <RightSidebar
        useStore={store}
        drawer={{ open: workbenchOpen, onOpenChange: setWorkbenchOpen }}
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

/**
 * Whether the device is currently held upright. `matchMedia` is the only
 * signal a web view gets for this, and it is live: the OS rotating the app
 * after the lock is released flips it without a re-mount.
 */
function usePortraitOrientation(): boolean {
  const [portrait, setPortrait] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(orientation: portrait)")
    const update = () => setPortrait(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return portrait
}
