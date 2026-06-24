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
import { ReactFlowProvider, type ReactFlowInstance, type Viewport } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useShallow } from "zustand/react/shallow"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { createWorkflow, getWorkflow, regenerateNodeIds, replaceWorkflow } from "@/lib/db/workflows"
import { reactFlowToWorkflow } from "@/lib/workflow/editor/react-flow-converter"
import { planExtraction } from "@/lib/workflow/editor/extract-subworkflow"
import { autoLayout, applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { createEditorStore, type EditorStore, type EditorState } from "@/lib/workflow/editor/store"
import { persistEditorWorkflow } from "@/lib/workflow/editor/persist-workflow"
import { downloadWorkflowJson, parseWorkflowImport } from "@/lib/workflow/editor/workflow-json"
import { outputHandlesFor } from "@/lib/workflow/editor/node-handles"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { runSingleNode } from "@/lib/workflow/runtime/run-single-node"
import { useRunStatusBridge } from "@/lib/workflow/runtime/run-status-bridge"
import { useLastRunSummaryByStep } from "@/lib/workflow/runtime/last-run-summary"
import {
  buildClipboardEnvelope,
  parseClipboard,
  serializeClipboard,
} from "@/lib/workflow/editor/clipboard"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import { paneCenterScreenPoint } from "@/lib/workflow/editor/pane-center"
import { useEffectivePerfTier } from "@/hooks/workflow/use-effective-perf-tier"
import { CanvasContextMenu, type ContextTarget } from "./canvas-context-menu"
import { SpotlightSearch } from "./spotlight-search"
import { ConnectionLineGhostFactory } from "./connection-overlay"
import { FlowCanvas } from "./flow-canvas"
import type { TriggerEvent } from "@/types/workflow/visual"
import { EditorToolbar } from "./toolbar"
import { CanvasToolbar, type CanvasBackgroundVariant } from "./canvas-toolbar"
import { SelectionToolbar } from "./selection-toolbar"
import { exportWorkflowImage, renderWorkflowImageBlob } from "@/lib/workflow/editor/export-image"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { workflowImagePayload } from "@/lib/share/payload"
import { EditorEmptyState } from "./empty-state"
import { NodeSearchSidebar, NODE_DRAG_MIME } from "./node-search-sidebar"
import { usePalettePreferencesStore } from "@/stores/workflow"
import { RightSidebar } from "./right-sidebar"
import { CommandPalette } from "./command-palette"
import { ShortcutsCheatsheet } from "./shortcuts-cheatsheet"
import * as ResizablePrimitive from "react-resizable-panels"
import { GripVerticalIcon } from "lucide-react"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

interface CanvasInnerProps {
  store: EditorStore
  onRequestRun: () => void
}

function CanvasInner({ store, onRequestRun }: CanvasInnerProps) {
  const useStore = store
  const t = useTranslations("workflows.canvasToast")
  const tValidation = useTranslations("workflows.validation")
  const tDiag = useTranslations("workflows.diagnostics")
  const tToolbar = useTranslations("workflows.toolbar")

  // (A8) Chrome slice — everything the editor *frame* needs that does NOT
  // change on every drag frame. Crucially this NO LONGER subscribes to
  // `nodes` / `edges`: those churn ~60×/s during a drag and used to re-render
  // this whole component (and its toolbars/sidebars/dialogs) with them. The
  // per-frame graph now lives entirely inside `<FlowCanvas>`. `viewport` is
  // kept because the store only updates it at `onMoveEnd` (once per pan), and
  // the toolbar's bookmark UI needs the live value; `nodeCount` (a primitive)
  // drives the empty-state and changes only on add/remove.
  const {
    dirty,
    viewport,
    workflowName,
    workflowId,
    nodeCount,
    setSelectedNodes,
    setName,
    markSaved,
    toWorkflow,
  } = useStore(
    useShallow((s: EditorState) => ({
      dirty: s.dirty,
      viewport: s.viewport,
      workflowName: s.baseWorkflow.name,
      workflowId: s.baseWorkflow.id,
      nodeCount: s.nodes.length,
      setSelectedNodes: s.setSelectedNodes,
      setName: s.setName,
      markSaved: s.markSaved,
      toWorkflow: s.toWorkflow,
    }))
  )

  // Snap toggle is owned by the canvas toolbar (chrome); the live `snapToGrid`
  // value is also subscribed inside `<FlowCanvas>` for React Flow.
  const snapToGrid = useStore((s) => s.snapToGrid)
  const setSnapToGrid = useStore((s) => s.setSnapToGrid)
  const setLastRunByStepId = useStore((s) => s.setLastRunByStepId)

  const perfTier = useEffectivePerfTier(useStore)

  // Custom connection-line component is created once per store instance —
  // its closure captures `useStore` so it can read connectionState while
  // the user is drawing an edge.
  const connectionLineGhost = useMemo(() => ConnectionLineGhostFactory(useStore), [useStore])

  // Wire the live run-status bridge so the canvas reflects what the
  // orchestrator is doing in real time.
  useRunStatusBridge(workflowId, useStore)
  // Aggregate per-step "last run" summaries across every run of this workflow
  // (Dexie liveQuery). Renders as the "Ran 12s ago · 1.4s" footer on each
  // node; runs in parallel with the live bridge above.
  const lastRunByStepId = useLastRunSummaryByStep(workflowId)

  // (A4) Mirror the Dexie-derived `lastRunByStepId` into the editor store
  // so per-node `useNodeDecoration` can pick it up via fine-grained
  // subscriptions. Identity comparison inside the action prevents churn
  // when liveQuery returns an unchanged snapshot.
  useEffect(() => {
    setLastRunByStepId(lastRunByStepId)
  }, [lastRunByStepId, setLastRunByStepId])

  const [saving, setSaving] = useState(false)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)
  // Canvas-toolbar view state. Local to this editor instance (the store is
  // recreated per workflow, so these reset on navigation) — see canvas-toolbar.
  // `interactive` mirrors React Flow's native lock; `minimapVisible` and
  // `backgroundVariant` were previously fixed and are now user-toggleable.
  const [interactive, setInteractive] = useState(true)
  const [minimapVisible, setMinimapVisible] = useState(true)
  const [backgroundVariant, setBackgroundVariant] = useState<CanvasBackgroundVariant>("dots")
  const toggleInteractive = useCallback(() => setInteractive((v) => !v), [])
  // Canvas context menu state — driven by React Flow's pane/node/edge
  // context-menu callbacks below.
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean
    position: { x: number; y: number } | null
    target: ContextTarget | null
  }>({ open: false, position: null, target: null })
  // The canvas wrapper element — Lasso overlay hooks pointerdown here so it
  // can intercept Alt+drag without fighting React Flow's selection box.
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null)
  const closeCtxMenu = useCallback(
    () => setCtxMenu({ open: false, position: null, target: null }),
    []
  )

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

  // Mini-toolbar "More" signal → open the canvas context menu at the
  // anchor coordinates the toolbar reported, then clear the request so the
  // same click doesn't re-trigger on the next render.
  const requestedContextMenu = useStore((s) => s.requestedContextMenu)
  useEffect(() => {
    if (!requestedContextMenu) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync requestedContextMenu (Zustand external state) into local UI state; intentional cascade.
    setCtxMenu({
      open: true,
      position: requestedContextMenu.screenAnchor,
      target: requestedContextMenu.target,
    })
    useStore.getState().clearRequestedContextMenu()
  }, [requestedContextMenu, useStore])

  // React Flow change/connect/drag/move handlers now live inside
  // `<FlowCanvas>` (the only per-frame subscriber). See flow-canvas.tsx.

  // ── Context menu callbacks ──────────────────────────────────────────────
  const handlePaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      const flowPos = reactFlowInstance
        ? reactFlowInstance.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          })
        : { x: 0, y: 0 }
      setCtxMenu({
        open: true,
        position: { x: event.clientX, y: event.clientY },
        target: { kind: "pane", flowPos },
      })
    },
    [reactFlowInstance]
  )

  const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: { id: string }) => {
    event.preventDefault()
    setCtxMenu({
      open: true,
      position: { x: event.clientX, y: event.clientY },
      target: { kind: "node", nodeId: node.id },
    })
  }, [])

  const handleEdgeContextMenu = useCallback((event: React.MouseEvent, edge: { id: string }) => {
    event.preventDefault()
    setCtxMenu({
      open: true,
      position: { x: event.clientX, y: event.clientY },
      target: { kind: "edge", edgeId: edge.id },
    })
  }, [])

  // useState declarations hoisted above the callbacks that capture their
  // setters — the React Compiler flags "access before declaration" otherwise.
  // The matching declarations further down were removed; do not re-introduce.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [spotlightOpen, setSpotlightOpen] = useState(false)

  // Add-node-from-handle (C2): a connection released on the empty pane stages a
  // pendingConnectFrom; opening the palette lets the user pick the kind, then
  // `handleAddFromPalette` creates + connects it. Closing the palette clears it.
  const pendingConnectFrom = useStore((s) => s.pendingConnectFrom)
  useEffect(() => {
    if (!pendingConnectFrom) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- bridge from the Zustand pendingConnectFrom signal into the local palette state.
    setPaletteOpen(true)
  }, [pendingConnectFrom])
  const handlePaletteOpenChange = useCallback(
    (open: boolean) => {
      setPaletteOpen(open)
      if (!open) useStore.getState().setPendingConnectFrom(null)
    },
    [useStore]
  )

  // Context-menu action thunks.
  const ctxAddNodeAtPosition = useCallback(
    (flowPos: { x: number; y: number }) => {
      useStore.getState().setPalettePrefillPosition(flowPos)
      setPaletteOpen(true)
    },
    [useStore]
  )
  const ctxResetView = useCallback(() => {
    reactFlowInstance?.fitView({
      duration: perfTier.flags.edgeAnimations ? 240 : 0,
      padding: 0.2,
    })
  }, [perfTier.flags.edgeAnimations, reactFlowInstance])
  const ctxConfigureNode = useCallback(
    (nodeId: string) => setSelectedNodes([nodeId]),
    [setSelectedNodes]
  )
  // Forward-declared via ref so the call sites below can reach the
  // post-declaration `handleRun`. The ref is wired by a `useEffect` after
  // handleRun is declared.
  const handleRunRef = useRef<((options?: { startStepId?: string }) => Promise<void>) | null>(null)
  const ctxRunFromNode = useCallback((nodeId: string) => {
    void handleRunRef.current?.({ startStepId: nodeId })
  }, [])
  // "Run this step" routes through the store signal so the canvas effect runs
  // it (keeps the single source of truth for run gating).
  const ctxRunSingleNode = useCallback(
    (nodeId: string) => {
      useStore.getState().requestRunSingleStep(nodeId)
    },
    [useStore]
  )
  const ctxCopyNode = useCallback(
    async (nodeId: string) => {
      const state = useStore.getState()
      const node = state.nodes.find((n) => n.id === nodeId)
      if (!node) return
      const envelope = buildClipboardEnvelope([node], [], [node.id])
      try {
        await navigator.clipboard.writeText(serializeClipboard(envelope))
      } catch {
        /* best effort */
      }
    },
    [useStore]
  )
  const ctxEditEdgeLabel = useCallback(
    (edgeId: string) => {
      useStore.getState().setEditingEdgeIdInline(edgeId)
    },
    [useStore]
  )
  const ctxPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      const envelope = parseClipboard(text)
      if (envelope) useStore.getState().pasteFromEnvelope(envelope)
    } catch {
      /* best effort — Clipboard API may be unavailable */
    }
  }, [useStore])

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      // Shared persist path (toWorkflow → replaceWorkflow → trigger sync →
      // markSaved → revalidate); the mobile editor uses the same helper.
      const issueCount = await persistEditorWorkflow(useStore)
      if (issueCount > 0) {
        toast.warning(tValidation("blockedSaveTitle", { count: issueCount }))
      } else {
        toast.success(t("savedOk"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }, [saving, useStore, t, tValidation])

  const [running, setRunning] = useState(false)
  const handleRun = useCallback(
    async (options?: { startStepId?: string }) => {
      if (running) return
      // Block runs on blocking (error-severity) diagnostics — the superset of
      // param errors PLUS expression-ref / orphan / credential / structural
      // problems. Warnings are surfaced but don't block (n8n / Dify parity).
      // The Problems panel + node/edge badges show the actual issues.
      const diagnostics = useStore.getState().recomputeDiagnostics()
      if (diagnostics.errorCount > 0) {
        toast.error(tDiag("blockedRunTitle"), {
          description: tDiag("blockedRunSummary", { count: diagnostics.errorCount }),
        })
        useStore.getState().requestProblemsPanel()
        return
      }
      if (diagnostics.warningCount > 0) {
        toast.warning(tDiag("runWithWarnings", { count: diagnostics.warningCount }))
      }
      setRunning(true)
      let toastId: string | number | undefined
      try {
        // Save dirty changes first so the run executes against what the user sees.
        if (dirty) {
          await replaceWorkflow(toWorkflow())
          markSaved()
        }
        const wf = toWorkflow()
        toastId = toast.loading(`${t("running")} ${wf.name}`)
        const trigger: TriggerEvent = {
          workflowId: wf.id,
          kind: "trigger.manual",
          payload: {},
          originAt: Date.now(),
        }
        const result = await runWorkflow({
          workflow: wf,
          trigger,
          startStepId: options?.startStepId,
          // Editor manual runs honor pinned node data (test fixtures); never
          // production triggers.
          honorPinData: true,
        })
        if (result.status === "succeeded") {
          toast.success(t("completed"), { id: toastId })
        } else {
          toast.error(`${t("runFailed")}: ${result.error?.message ?? "unknown error"}`, {
            id: toastId,
          })
        }
        // The parent (e.g., the editor page) can hook in to navigate to /runs.
        onRequestRun()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("startFailed"), {
          id: toastId,
        })
      } finally {
        setRunning(false)
      }
    },
    [running, dirty, toWorkflow, markSaved, onRequestRun, t, tDiag, useStore]
  )

  const handleRevert = useCallback(async () => {
    const row = await getWorkflow(workflowId)
    // Never persisted (brand-new workflow) — nothing to revert to.
    if (!row) return
    useStore.getState().loadWorkflow(row)
    toast.success(tToolbar("reverted"))
  }, [workflowId, useStore, tToolbar])

  // Extract the current node selection into a new sub-workflow (C5): build a
  // child workflow from the selected subset + their internal edges, persist it,
  // and replace the selection on this canvas with one flow.subworkflow node
  // that rewires the boundary edges.
  const handleExtractToSubworkflow = useCallback(async () => {
    const state = useStore.getState()
    const selectedIds = state.selectedNodeIds
    const hasExecutable = selectedIds.some((id) => {
      const kind = (state.nodes.find((n) => n.id === id)?.data.kind as string) ?? ""
      return kind && !kind.startsWith("annotation.")
    })
    if (!hasExecutable) return
    const plan = planExtraction(
      selectedIds,
      state.nodes.map((n) => ({ id: n.id, position: n.position })),
      state.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      }))
    )
    if (!plan) return
    const selectedSet = new Set(plan.selectedIds)
    // Selected nodes → child, flattened: drop parentId/extent so the child has
    // no dangling container references (regenerateNodeIds doesn't remap
    // parentId). Container nesting isn't preserved across extraction.
    const childNodes = state.nodes
      .filter((n) => selectedSet.has(n.id))
      .map((n) => {
        const { parentId: _p, extent: _e, ...rest } = n
        return { ...rest, selected: false }
      })
    const internalSet = new Set(plan.internalEdgeIds)
    const childEdges = state.edges
      .filter((e) => internalSet.has(e.id))
      .map((e) => ({ ...e, selected: false }))
    const parent = state.toWorkflow()
    const base: VisualWorkflow = {
      ...parent,
      id: "",
      name: "",
      nodes: [],
      edges: [],
      pinData: undefined,
      staticData: undefined,
      viewport: undefined,
      createdAt: 0,
      updatedAt: 0,
    }
    let child = reactFlowToWorkflow(base, childNodes, childEdges, { x: 0, y: 0, zoom: 1 })
    // Inject a manual trigger wired to the child's root nodes if it has none,
    // BEFORE regenerating ids so the trigger + its edges get fresh ids too.
    if (!child.nodes.some((n) => n.type.startsWith("trigger."))) {
      const targets = new Set(child.edges.map((e) => e.target))
      const roots = child.nodes.filter(
        (n) => !targets.has(n.id) && !n.type.startsWith("annotation.")
      )
      const trigId = "__extract_trigger__"
      child = {
        ...child,
        nodes: [
          {
            id: trigId,
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: -200, y: 0 },
            data: { label: "Manual trigger", params: {} },
          },
          ...child.nodes,
        ],
        edges: [
          ...child.edges,
          ...roots.map((r, i) => ({ id: `__extract_e${i}__`, source: trigId, target: r.id })),
        ],
      }
    }
    child = regenerateNodeIds(child)
    try {
      const childRow = await createWorkflow({
        name: `${workflowName} (extracted)`,
        nodes: child.nodes,
        edges: child.edges,
        settings: child.settings,
      })
      useStore.getState().replaceSelectionWithNode(
        selectedIds,
        {
          kind: "flow.subworkflow",
          params: { workflowId: childRow.id },
          position: plan.center,
          label: `${workflowName} (sub)`,
        },
        {
          inbound: plan.inbound.map((i) => ({
            source: i.externalSource,
            sourceHandle: i.sourceHandle,
          })),
          outbound: plan.outbound.map((o) => ({
            target: o.externalTarget,
            targetHandle: o.targetHandle,
          })),
        }
      )
      toast.success(t("extracted"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"))
    }
  }, [useStore, workflowName, t])

  const handleUndo = useCallback(() => useStore.temporal.getState().undo(), [useStore])
  const handleRedo = useCallback(() => useStore.temporal.getState().redo(), [useStore])

  // Wire the forward-declared `handleRunRef` to the latest `handleRun`
  // closure so the mini-toolbar / context-menu "Run from here" handlers
  // declared earlier in the body can invoke it.
  useEffect(() => {
    handleRunRef.current = handleRun
    return () => {
      handleRunRef.current = null
    }
  }, [handleRun])

  // Mini-toolbar "Run from here" signal → kicks off `handleRun` with a
  // start step id so the orchestrator scopes the run to the descendant
  // subgraph. Clearing the request before awaiting `handleRun` keeps the
  // slot ready for a follow-up request from a different node.
  const requestedRunFromStepId = useStore((s) => s.requestedRunFromStepId)
  useEffect(() => {
    if (!requestedRunFromStepId) return
    const stepId = requestedRunFromStepId
    useStore.getState().clearRequestedRunFromStep()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- handleRun sets state internally; this is the intentional bridge from Zustand requestedRunFromStep into the local runner.
    void handleRun({ startStepId: stepId })
  }, [requestedRunFromStepId, useStore, handleRun])

  // "Run this step" — execute ONLY the target node (reusing pinned / last-run
  // upstream). Distinct from "Run from here" (target + downstream). Saves dirty
  // changes first, like handleRun.
  const handleRunSingleStep = useCallback(
    async (nodeId: string) => {
      if (running) return
      const diagnostics = useStore.getState().recomputeDiagnostics()
      if (diagnostics.errorCount > 0) {
        toast.error(tDiag("blockedRunTitle"), {
          description: tDiag("blockedRunSummary", { count: diagnostics.errorCount }),
        })
        useStore.getState().requestProblemsPanel()
        return
      }
      if (diagnostics.warningCount > 0) {
        toast.warning(tDiag("runWithWarnings", { count: diagnostics.warningCount }))
      }
      setRunning(true)
      let toastId: string | number | undefined
      try {
        if (dirty) {
          await replaceWorkflow(toWorkflow())
          markSaved()
        }
        const wf = toWorkflow()
        toastId = toast.loading(`${t("running")} ${wf.name}`)
        const result = await runSingleNode({ workflow: wf, nodeId })
        if (result.status === "succeeded") {
          toast.success(t("completed"), { id: toastId })
        } else {
          toast.error(`${t("runFailed")}: ${result.error?.message ?? "unknown error"}`, {
            id: toastId,
          })
        }
        onRequestRun()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("startFailed"), { id: toastId })
      } finally {
        setRunning(false)
      }
    },
    [running, dirty, toWorkflow, markSaved, onRequestRun, t, tDiag, useStore]
  )

  const requestedRunSingleStepId = useStore((s) => s.requestedRunSingleStepId)
  useEffect(() => {
    if (!requestedRunSingleStepId) return
    const stepId = requestedRunSingleStepId
    useStore.getState().clearRequestedRunSingleStep()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- handleRunSingleStep sets state internally; intentional bridge from Zustand into the local runner.
    void handleRunSingleStep(stepId)
  }, [requestedRunSingleStepId, useStore, handleRunSingleStep])

  const handleAutoLayout = useCallback(async () => {
    const s = useStore.getState()
    const positions = await autoLayout(s.nodes, s.edges)
    if (Object.keys(positions).length === 0) {
      toast.error(t("layoutUnavailable"))
      return
    }
    s.setNodes(applyAutoLayoutPositions(s.nodes, positions))
    requestAnimationFrame(() => reactFlowInstance?.fitView({ duration: 250, padding: 0.2 }))
  }, [useStore, reactFlowInstance, t])

  // ── JSON export / import ──────────────────────────────────────────────────
  const handleExportJson = useCallback(() => {
    downloadWorkflowJson(toWorkflow())
    toast.success(t("exported"))
  }, [toWorkflow, t])

  const [shareImageOpen, setShareImageOpen] = useState(false)

  const handleExportImage = useCallback(async () => {
    const el = canvasWrapperRef.current
    if (!el) return
    try {
      await exportWorkflowImage({
        flowEl: el,
        nodes: useStore.getState().nodes,
        fileName: workflowName.replace(/[^a-z0-9-_]+/gi, "_") || "workflow",
        backgroundColor: null,
      })
      toast.success(t("imageExported"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("imageExportFailed"))
    }
  }, [useStore, workflowName, t])

  const buildImageSharePayload = useCallback(async () => {
    const el = canvasWrapperRef.current
    if (!el) throw new Error("Canvas not ready")
    const blob = await renderWorkflowImageBlob({
      flowEl: el,
      nodes: useStore.getState().nodes,
      backgroundColor: null,
    })
    return workflowImagePayload(blob, workflowName || "workflow")
  }, [useStore, workflowName])

  const handleImportJson = useCallback(
    (jsonText: string) => {
      try {
        const parsed = parseWorkflowImport(jsonText)
        useStore.getState().loadWorkflow({
          ...useStore.getState().toWorkflow(),
          ...parsed,
          // Preserve current id so we don't accidentally overwrite a different
          // workflow on save. If the user wants a fresh row, they should
          // duplicate from the library afterwards.
          id: useStore.getState().baseWorkflow.id,
        } as VisualWorkflow)
        toast.success(t("imported"))
      } catch (err) {
        toast.error(
          err instanceof Error ? `${t("importFailed")}: ${err.message}` : t("importFailed")
        )
      }
    },
    [useStore, t]
  )

  const handleAddFromPalette = useCallback(
    (kind: WorkflowNodeKind) => {
      // From a dragged handle (C2): create the node at the drop point and wire
      // the source → it. Falls back to a free node if the connection is illegal.
      const pending = useStore.getState().pendingConnectFrom
      if (pending) {
        const connectedId =
          useStore.getState().addNodeConnected(kind, pending.dropPos, {
            sourceId: pending.sourceId,
            sourceHandle: pending.sourceHandle,
          }) ?? useStore.getState().addNode(kind, pending.dropPos)
        useStore.getState().setPendingConnectFrom(null)
        setSelectedNodes([connectedId])
        return
      }
      const center = reactFlowInstance?.screenToFlowPosition(
        paneCenterScreenPoint(canvasWrapperRef.current?.getBoundingClientRect())
      )
      const id = useStore.getState().addNode(kind, center ?? { x: 80, y: 80 })
      setSelectedNodes([id])
    },
    [reactFlowInstance, useStore, setSelectedNodes]
  )

  // Stable callbacks for the chrome toolbars. These let the memoized
  // CanvasToolbar / EditorToolbar skip the per-frame re-render that
  // CanvasInner fires during a node drag (setNodes + alignment-guide state) —
  // inline arrows here would defeat the memo by changing identity each render.
  const handleOpenPalette = useCallback(() => setPaletteOpen(true), [])
  const handleOpenSpotlight = useCallback(() => setSpotlightOpen(true), [])
  const handleOpenShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const handleAddSticky = useCallback(
    () => handleAddFromPalette("annotation.note"),
    [handleAddFromPalette]
  )
  const handleAddGroup = useCallback(
    () => handleAddFromPalette("annotation.group"),
    [handleAddFromPalette]
  )
  const handleRestoreViewport = useCallback(
    (vp: Viewport) =>
      reactFlowInstance?.setViewport(vp, {
        duration: perfTier.flags.edgeAnimations ? 400 : 0,
      }),
    [reactFlowInstance, perfTier.flags.edgeAnimations]
  )

  // Keyboard shortcuts: Ctrl/Cmd+S, Z/Shift-Z/Y, K — plus clipboard/group
  // family (A/C/X/V/D/G). Skip when focus is in an input / textarea / CM
  // editor so typing in the inspector doesn't fight the canvas shortcuts.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
      if (target.isContentEditable) return true
      // CodeMirror's host wraps a contenteditable inside `.cm-editor`.
      if (target.closest(".cm-editor")) return true
      return false
    }
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      // Ctrl+/ (or just `?` when not typing) opens the shortcuts cheatsheet.
      if (mod && e.key === "/") {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }
      // Tab → keyboard create+connect (C3): with exactly one node selected,
      // stage a node to its right wired from its default output handle. The
      // pendingConnectFrom effect then opens the palette to pick the kind.
      if (e.key === "Tab" && !mod && !e.shiftKey) {
        if (isEditableTarget(e.target)) return
        const state = useStore.getState()
        if (state.selectedNodeIds.length !== 1) return
        const node = state.nodes.find((n) => n.id === state.selectedNodeIds[0])
        if (!node) return
        e.preventDefault()
        const handles = outputHandlesFor({
          kind: node.data.kind as WorkflowNodeKind,
          typeVersion: node.data.typeVersion ?? 1,
          params: (node.data.params as Record<string, unknown>) ?? {},
        })
        state.setPendingConnectFrom({
          sourceId: node.id,
          sourceHandle: handles && handles.length > 0 ? handles[0].id : null,
          dropPos: { x: node.position.x + 320, y: node.position.y },
        })
        return
      }
      if (!mod) return
      const key = e.key.toLowerCase()
      // Save / undo / redo / palette — never blocked even when the inspector
      // has focus, because they're idempotent saves / history nav.
      if (key === "s") {
        e.preventDefault()
        void handleSave()
        return
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
        return
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault()
        handleRedo()
        return
      }
      if (key === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // Ctrl/Cmd+F → in-canvas Spotlight search. Skipped when typing into
      // an inspector field so the browser's native find UI still works
      // for `<input>` values.
      if (key === "f" && !e.shiftKey) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        setSpotlightOpen((v) => !v)
        return
      }
      // Clipboard + selection family — do nothing while the user is typing
      // inside an inspector field; the browser's native handling owns it.
      if (isEditableTarget(e.target)) return
      const state = useStore.getState()
      if (key === "a") {
        e.preventDefault()
        state.selectAll()
        return
      }
      if (key === "c") {
        const selected = state.selectedNodeIds
        if (selected.length === 0) return
        e.preventDefault()
        const env = buildClipboardEnvelope(state.nodes, state.edges, selected)
        navigator.clipboard?.writeText(serializeClipboard(env)).catch(() => {})
        return
      }
      if (key === "x") {
        const selected = state.selectedNodeIds
        if (selected.length === 0) return
        e.preventDefault()
        const env = buildClipboardEnvelope(state.nodes, state.edges, selected)
        navigator.clipboard
          ?.writeText(serializeClipboard(env))
          .then(() => state.removeNodes(selected))
          .catch(() => state.removeNodes(selected))
        return
      }
      if (key === "v") {
        e.preventDefault()
        navigator.clipboard
          ?.readText()
          .then((text) => {
            const env = parseClipboard(text)
            if (env) state.pasteFromEnvelope(env)
          })
          .catch(() => {})
        return
      }
      if (key === "d") {
        const selected = state.selectedNodeIds
        if (selected.length === 0) return
        e.preventDefault()
        state.duplicateNodes(selected)
        return
      }
      if (key === "g") {
        const selected = state.selectedNodeIds
        if (selected.length < 2) return
        e.preventDefault()
        state.groupSelected(selected)
        return
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [handleSave, handleUndo, handleRedo, useStore])

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
      // Hit-test: did the drop land on an edge? If so, split it
      // (source → new → target) instead of dropping a free node.
      let id: string | null = null
      const el =
        typeof document !== "undefined"
          ? document.elementFromPoint(event.clientX, event.clientY)
          : null
      const edgeId = (el?.closest?.(".react-flow__edge") as HTMLElement | null)?.getAttribute(
        "data-id"
      )
      if (edgeId) {
        id = useStore.getState().insertNodeOnEdge(edgeId, kind as WorkflowNodeKind, position)
      }
      if (!id) {
        id = useStore.getState().addNode(kind as WorkflowNodeKind, position)
      }
      usePalettePreferencesStore.getState().recordUsed(kind)
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
      const center = reactFlowInstance.screenToFlowPosition(
        paneCenterScreenPoint(canvasWrapperRef.current?.getBoundingClientRect())
      )
      const id = useStore.getState().addNode(entry.kind, center)
      usePalettePreferencesStore.getState().recordUsed(entry.kind)
      setSelectedNodes([id])
    },
    [reactFlowInstance, useStore, setSelectedNodes]
  )

  const showEmpty = nodeCount === 0

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
        onRevert={handleRevert}
        onExportJson={handleExportJson}
        onExportImage={handleExportImage}
        onShareImage={() => setShareImageOpen(true)}
        onImportJson={handleImportJson}
        onOpenCommandPalette={handleOpenPalette}
        onOpenShortcuts={handleOpenShortcuts}
      />
      <ShareLinkDialog
        open={shareImageOpen}
        onOpenChange={setShareImageOpen}
        buildPayload={buildImageSharePayload}
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
        <ResizablePrimitive.Panel defaultSize="20%" minSize="14%" maxSize="32%">
          <NodeSearchSidebar onAddNodeAtCenter={handleAddAtCenter} />
        </ResizablePrimitive.Panel>
        <ResizablePrimitive.Separator className="relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none">
          <div className="z-10 flex h-4 w-3 items-center justify-center rounded border bg-border">
            <GripVerticalIcon className="size-2.5" />
          </div>
        </ResizablePrimitive.Separator>
        <ResizablePrimitive.Panel defaultSize="56%" minSize="30%">
          <FlowCanvas
            store={useStore}
            perfTier={perfTier}
            reactFlowInstance={reactFlowInstance}
            setReactFlowInstance={setReactFlowInstance}
            canvasWrapperRef={canvasWrapperRef}
            interactive={interactive}
            minimapVisible={minimapVisible}
            backgroundVariant={backgroundVariant}
            minimapNodeColor={minimapNodeColor}
            connectionLineGhost={connectionLineGhost}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onPaneContextMenu={handlePaneContextMenu}
            onNodeContextMenu={handleNodeContextMenu}
            onEdgeContextMenu={handleEdgeContextMenu}
            overlays={
              <>
                <SelectionToolbar
                  store={useStore}
                  reactFlowInstance={reactFlowInstance}
                  motionEnabled={perfTier.flags.edgeAnimations}
                  onExtractToSubworkflow={handleExtractToSubworkflow}
                />
                <CanvasToolbar
                  onAddNode={handleOpenPalette}
                  onOpenSearch={handleOpenSpotlight}
                  onAddSticky={handleAddSticky}
                  onAddGroup={handleAddGroup}
                  onUndo={handleUndo}
                  onRedo={handleRedo}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onAutoLayout={handleAutoLayout}
                  interactive={interactive}
                  onToggleInteractive={toggleInteractive}
                  snapToGrid={snapToGrid}
                  onToggleSnap={setSnapToGrid}
                  minimapVisible={minimapVisible}
                  minimapAvailable={perfTier.flags.showMinimap}
                  onToggleMinimap={setMinimapVisible}
                  backgroundVariant={backgroundVariant}
                  onBackgroundChange={setBackgroundVariant}
                  motionEnabled={perfTier.flags.edgeAnimations}
                  performanceTier={perfTier.userChoice}
                  effectivePerformanceTier={perfTier.effective}
                  onPerformanceTierChange={perfTier.setUserChoice}
                  workflowId={workflowId}
                  currentViewport={viewport}
                  onRestoreViewport={handleRestoreViewport}
                />
                {showEmpty ? <EditorEmptyState onAddNode={addManualTrigger} /> : null}
              </>
            }
          />
        </ResizablePrimitive.Panel>
        <ResizablePrimitive.Separator className="relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none">
          <div className="z-10 flex h-4 w-3 items-center justify-center rounded border bg-border">
            <GripVerticalIcon className="size-2.5" />
          </div>
        </ResizablePrimitive.Separator>
        <ResizablePrimitive.Panel defaultSize="28%" minSize="20%" maxSize="42%">
          <RightSidebar
            useStore={store}
            className="h-full w-full"
            reactFlowInstance={reactFlowInstance}
          />
        </ResizablePrimitive.Panel>
      </ResizablePrimitive.Group>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={handlePaletteOpenChange}
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
      <ShortcutsCheatsheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <SpotlightSearch
        open={spotlightOpen}
        onOpenChange={setSpotlightOpen}
        store={useStore}
        reactFlowInstance={reactFlowInstance}
        animationsEnabled={perfTier.flags.edgeAnimations}
      />
      <CanvasContextMenu
        open={ctxMenu.open}
        position={ctxMenu.position}
        target={ctxMenu.target}
        store={useStore}
        onClose={closeCtxMenu}
        onAddNodeAtPosition={ctxAddNodeAtPosition}
        onResetView={ctxResetView}
        onConfigureNode={ctxConfigureNode}
        onRunFromNode={ctxRunFromNode}
        onRunSingleNode={ctxRunSingleNode}
        onCopyNode={ctxCopyNode}
        onEditEdgeLabel={ctxEditEdgeLabel}
        onPaste={ctxPaste}
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
      <EditorStoreProvider store={store}>
        <CanvasInner store={store} onRequestRun={onRequestRun ?? noop} />
      </EditorStoreProvider>
    </ReactFlowProvider>
  )
}
