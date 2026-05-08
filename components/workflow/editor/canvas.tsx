"use client"

/**
 * Workflow editor canvas — wires React Flow to the per-editor Zustand+zundo
 * store. The component manages: node/edge state sync, selection, viewport,
 * undo/redo keyboard shortcuts, save-on-Ctrl+S, and connect-on-drag.
 *
 * Custom node visual polish (status pills, last-run badges, etc.) is owned
 * by the per-kind components in `./nodes/`. Phase 2 ships a single
 * `WorkflowNodeComponent` that renders every kind with shadcn-styled cards;
 * Phase 9 adds the runtime-state badges.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useShallow } from "zustand/react/shallow"
import { toast } from "sonner"
import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { replaceWorkflow } from "@/lib/db/workflows"
import { autoLayout, applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { createEditorStore, type EditorStore, type EditorState } from "@/lib/workflow/editor/store"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { useRunStatusBridge } from "@/lib/workflow/runtime/run-status-bridge"
import { syncWorkflowTriggers } from "@/lib/workflow/runtime/webhook-bridge"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"
import type { TriggerEvent } from "@/types/workflow/visual"
import { WorkflowNodeComponent } from "./nodes/workflow-node"
import { EditorToolbar } from "./toolbar"
import { EditorEmptyState } from "./empty-state"
import { NodeSearchSidebar, NODE_DRAG_MIME } from "./node-search-sidebar"
import { InspectorPanel } from "./inspector-panel"
import { CommandPalette } from "./command-palette"
import * as ResizablePrimitive from "react-resizable-panels"
import { GripVerticalIcon } from "lucide-react"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

const nodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent as unknown as NodeTypes[string],
}

interface CanvasInnerProps {
  store: EditorStore
  onRequestRun: () => void
}

function CanvasInner({ store, onRequestRun }: CanvasInnerProps) {
  const useStore = store

  const {
    nodes,
    edges,
    viewport,
    dirty,
    workflowName,
    workflowId,
    runStatusByStepId,
    validationByStepId,
    setNodes,
    setEdges,
    setViewport,
    setSelectedNodes,
    setSelectedEdges,
    setName,
    markSaved,
    toWorkflow,
  } = useStore(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      edges: s.edges,
      viewport: s.viewport,
      dirty: s.dirty,
      workflowName: s.baseWorkflow.name,
      workflowId: s.baseWorkflow.id,
      runStatusByStepId: s.runStatusByStepId,
      validationByStepId: s.validationByStepId,
      setNodes: s.setNodes,
      setEdges: s.setEdges,
      setViewport: s.setViewport,
      setSelectedNodes: s.setSelectedNodes,
      setSelectedEdges: s.setSelectedEdges,
      setName: s.setName,
      markSaved: s.markSaved,
      toWorkflow: s.toWorkflow,
    }))
  )

  // Wire the live run-status bridge so the canvas reflects what the
  // orchestrator is doing in real time.
  useRunStatusBridge(workflowId, useStore)

  // Merge the live runStatus + validation errors into each node's `data` so
  // `WorkflowNodeComponent` can render the status ring without the runtime
  // events plumbing leaking down to each node.
  const decoratedNodes = useMemo(() => {
    return nodes.map((n) => {
      const status = runStatusByStepId[n.id]
      const errors = validationByStepId[n.id]
      if (!status && !errors) return n
      return {
        ...n,
        data: {
          ...n.data,
          ...(status ? { runStatus: status } : {}),
          ...(errors ? { validationErrors: errors } : {}),
        },
      }
    })
  }, [nodes, runStatusByStepId, validationByStepId])

  const [saving, setSaving] = useState(false)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)

  // Track undo/redo availability so the toolbar can disable its buttons.
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  useEffect(() => {
    const temporal = useStore.temporal
    const update = () => {
      const s = temporal.getState()
      setCanUndo(s.pastStates.length > 0)
      setCanRedo(s.futureStates.length > 0)
    }
    update()
    return temporal.subscribe(update)
  }, [useStore])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes(applyNodeChanges(changes, nodes) as typeof nodes)
      const selected = changes
        .filter((c): c is Extract<NodeChange, { type: "select" }> => c.type === "select")
        .filter((c) => c.selected)
        .map((c) => c.id)
      if (selected.length > 0) setSelectedNodes(selected)
    },
    [nodes, setNodes, setSelectedNodes]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, edges) as typeof edges)
      const selected = changes
        .filter((c): c is Extract<EdgeChange, { type: "select" }> => c.type === "select")
        .filter((c) => c.selected)
        .map((c) => c.id)
      if (selected.length > 0) setSelectedEdges(selected)
    },
    [edges, setEdges, setSelectedEdges]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const result = validateConnection(connection, nodes, edges)
      if (!result.valid) {
        toast.error(result.reason)
        return
      }
      setEdges(
        addEdge(
          {
            ...connection,
            id: "e_" + Math.random().toString(36).slice(2, 10),
            type: "default",
          },
          edges
        ) as typeof edges
      )
    },
    [nodes, edges, setEdges]
  )

  const isValidConnection = useCallback(
    (connection: Connection | { source: string | null; target: string | null }) =>
      validateConnection(connection, nodes, edges).valid,
    [nodes, edges]
  )

  const onMoveEnd = useCallback((_e: unknown, v: Viewport) => setViewport(v), [setViewport])

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      const wf: VisualWorkflow = toWorkflow()
      await replaceWorkflow(wf)
      // Push the workflow's trigger nodes to the Rust side so cron / webhook
      // triggers fire even when the editor is closed. Web-mode no-ops.
      await syncWorkflowTriggers(wf).catch((err: unknown) => {
        console.warn("syncWorkflowTriggers failed:", err)
      })
      markSaved()
      toast.success("Workflow saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save workflow")
    } finally {
      setSaving(false)
    }
  }, [saving, toWorkflow, markSaved])

  const [running, setRunning] = useState(false)
  const handleRun = useCallback(async () => {
    if (running) return
    setRunning(true)
    let toastId: string | number | undefined
    try {
      // Save dirty changes first so the run executes against what the user sees.
      if (dirty) {
        await replaceWorkflow(toWorkflow())
        markSaved()
      }
      const wf = toWorkflow()
      toastId = toast.loading(`Running ${wf.name}…`)
      const trigger: TriggerEvent = {
        workflowId: wf.id,
        kind: "trigger.manual",
        payload: {},
        originAt: Date.now(),
      }
      const result = await runWorkflow({ workflow: wf, trigger })
      if (result.status === "succeeded") {
        toast.success("Workflow completed", { id: toastId })
      } else {
        toast.error(`Run failed: ${result.error?.message ?? "unknown error"}`, {
          id: toastId,
        })
      }
      // The parent (e.g., the editor page) can hook in to navigate to /runs.
      onRequestRun()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start run", {
        id: toastId,
      })
    } finally {
      setRunning(false)
    }
  }, [running, dirty, toWorkflow, markSaved, onRequestRun])

  const handleUndo = useCallback(() => useStore.temporal.getState().undo(), [useStore])
  const handleRedo = useCallback(() => useStore.temporal.getState().redo(), [useStore])

  const handleAutoLayout = useCallback(async () => {
    const positions = await autoLayout(nodes, edges)
    if (Object.keys(positions).length === 0) {
      toast.error("Auto-layout unavailable in this environment")
      return
    }
    setNodes(applyAutoLayoutPositions(nodes, positions))
    requestAnimationFrame(() => reactFlowInstance?.fitView({ duration: 250, padding: 0.2 }))
  }, [nodes, edges, setNodes, reactFlowInstance])

  // ── JSON export / import ──────────────────────────────────────────────────
  const handleExportJson = useCallback(() => {
    const wf = toWorkflow()
    const blob = new Blob([JSON.stringify(wf, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${wf.name.replace(/[^a-z0-9-_]+/gi, "_") || "workflow"}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success("Workflow JSON downloaded")
  }, [toWorkflow])

  const handleImportJson = useCallback(
    (jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as Partial<VisualWorkflow>
        if (!parsed || typeof parsed !== "object") throw new Error("Top-level must be an object")
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error("Missing 'nodes' or 'edges' array")
        }
        useStore.getState().loadWorkflow({
          ...useStore.getState().toWorkflow(),
          ...parsed,
          // Preserve current id so we don't accidentally overwrite a different
          // workflow on save. If the user wants a fresh row, they should
          // duplicate from the library afterwards.
          id: useStore.getState().baseWorkflow.id,
        } as VisualWorkflow)
        toast.success("Workflow imported")
      } catch (err) {
        toast.error(
          err instanceof Error ? `Import failed: ${err.message}` : "Import failed: invalid JSON"
        )
      }
    },
    [useStore]
  )

  const [paletteOpen, setPaletteOpen] = useState(false)
  const handleAddFromPalette = useCallback(
    (kind: WorkflowNodeKind) => {
      const center = reactFlowInstance?.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })
      const id = useStore.getState().addNode(kind, center ?? { x: 80, y: 80 })
      setSelectedNodes([id])
    },
    [reactFlowInstance, useStore, setSelectedNodes]
  )

  // Keyboard shortcuts: Ctrl/Cmd+S, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key.toLowerCase() === "s") {
        e.preventDefault()
        void handleSave()
      } else if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") {
        e.preventDefault()
        handleRedo()
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [handleSave, handleUndo, handleRedo])

  const addManualTrigger = useCallback(() => {
    const id = useStore.getState().addNode("trigger.manual", { x: 80, y: 80 })
    setSelectedNodes([id])
  }, [useStore, setSelectedNodes])

  // Drop a sidebar entry onto the canvas. We project the cursor coords into
  // React Flow's coordinate system and call the store's addNode there.
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const kind = event.dataTransfer.getData(NODE_DRAG_MIME)
      if (!kind || !reactFlowInstance) return
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      const id = useStore.getState().addNode(kind as WorkflowNodeKind, position)
      setSelectedNodes([id])
    },
    [reactFlowInstance, useStore, setSelectedNodes]
  )

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
  }, [])

  // Sidebar entry click → drop at center of viewport (works without DnD).
  const handleAddAtCenter = useCallback(
    (entry: NodeCatalogEntry) => {
      if (!reactFlowInstance) return
      const center = reactFlowInstance.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })
      const id = useStore.getState().addNode(entry.kind, center)
      setSelectedNodes([id])
    },
    [reactFlowInstance, useStore, setSelectedNodes]
  )

  const showEmpty = nodes.length === 0

  const minimapNodeColor = useCallback((n: { data?: { kind?: WorkflowNodeKind } }) => {
    const kind = n.data?.kind
    if (!kind) return "#94a3b8"
    if (kind.startsWith("trigger.")) return "#10b981"
    if (kind.startsWith("action.")) return "#0ea5e9"
    if (kind.startsWith("ai.")) return "#8b5cf6"
    if (kind.startsWith("flow.")) return "#f59e0b"
    if (kind.startsWith("data.")) return "#f43f5e"
    if (kind.startsWith("io.")) return "#06b6d4"
    return "#71717a"
  }, [])

  // Open the file picker programmatically when the command palette asks us to.
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const handleImportRequest = useCallback(() => {
    importInputRef.current?.click()
  }, [])
  const handleImportInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : ""
        if (text) handleImportJson(text)
      }
      reader.readAsText(file)
    },
    [handleImportJson]
  )

  return (
    <div className="flex h-full w-full flex-col">
      <EditorToolbar
        workflowName={workflowName}
        onRename={setName}
        dirty={dirty}
        saving={saving || running}
        onSave={handleSave}
        onRun={handleRun}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onAutoLayout={handleAutoLayout}
        onExportJson={handleExportJson}
        onImportJson={handleImportJson}
        onOpenCommandPalette={() => setPaletteOpen(true)}
      />
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportInputChange}
      />
      <ResizablePrimitive.Group
        orientation="horizontal"
        className="flex flex-1 overflow-hidden"
        id="cognia-workflow-editor-layout"
      >
        <ResizablePrimitive.Panel defaultSize={20} minSize={14} maxSize={32}>
          <NodeSearchSidebar onAddNodeAtCenter={handleAddAtCenter} />
        </ResizablePrimitive.Panel>
        <ResizablePrimitive.Separator className="relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none">
          <div className="z-10 flex h-4 w-3 items-center justify-center rounded border bg-border">
            <GripVerticalIcon className="size-2.5" />
          </div>
        </ResizablePrimitive.Separator>
        <ResizablePrimitive.Panel defaultSize={56} minSize={30}>
          <div
            className="relative h-full w-full overflow-hidden bg-muted/30"
            data-testid="workflow-canvas"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            <ReactFlow
              nodes={decoratedNodes}
              edges={edges}
              viewport={viewport}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onMoveEnd={onMoveEnd}
              onInit={setReactFlowInstance}
              nodeTypes={nodeTypes}
              fitView={false}
              minZoom={0.2}
              maxZoom={2}
              snapToGrid
              snapGrid={[16, 16]}
              deleteKeyCode={["Backspace", "Delete"]}
              multiSelectionKeyCode={["Shift", "Meta", "Control"]}
              panOnScroll
              selectionOnDrag
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <Controls position="bottom-left" />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={minimapNodeColor as unknown as () => string}
                className="!rounded-md !border !bg-background"
              />
            </ReactFlow>
            {showEmpty ? <EditorEmptyState onAddNode={addManualTrigger} /> : null}
          </div>
        </ResizablePrimitive.Panel>
        <ResizablePrimitive.Separator className="relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none">
          <div className="z-10 flex h-4 w-3 items-center justify-center rounded border bg-border">
            <GripVerticalIcon className="size-2.5" />
          </div>
        </ResizablePrimitive.Separator>
        <ResizablePrimitive.Panel defaultSize={24} minSize={18} maxSize={40}>
          <InspectorPanel useStore={store} className="h-full w-full" />
        </ResizablePrimitive.Panel>
      </ResizablePrimitive.Group>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        currentWorkflowId={workflowId}
        onAddNode={handleAddFromPalette}
        onSave={handleSave}
        onRun={handleRun}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAutoLayout={handleAutoLayout}
        onExportJson={handleExportJson}
        onImportJsonRequest={handleImportRequest}
      />
    </div>
  )
}

export interface WorkflowEditorCanvasProps {
  workflow: VisualWorkflow
  onRequestRun?: () => void
}

export function WorkflowEditorCanvas({ workflow, onRequestRun }: WorkflowEditorCanvasProps) {
  // One store per (component instance × workflow id). When the user navigates
  // to a different workflow the lazy initializer + render-time reset rebuild
  // the store + history stack.
  const [store, setStore] = useState<EditorStore>(() => createEditorStore(workflow))
  const [storedWorkflowId, setStoredWorkflowId] = useState(workflow.id)
  if (storedWorkflowId !== workflow.id) {
    setStoredWorkflowId(workflow.id)
    setStore(createEditorStore(workflow))
  }
  const noop = useMemo(() => () => undefined, [])

  return (
    <ReactFlowProvider>
      <CanvasInner store={store} onRequestRun={onRequestRun ?? noop} />
    </ReactFlowProvider>
  )
}
