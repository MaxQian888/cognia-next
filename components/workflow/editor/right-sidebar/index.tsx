"use client"

/**
 * The workflow editor's right sidebar — a `ContextWorkbench` host (ADR-0083).
 *
 * There is one shell. The editor's own pre-0083 Tabs container is gone, as is
 * the dockview grid that briefly sat beside it; every surface the sidebar ever
 * showed (chat, comments, inspector, problems, runs, templates, settings,
 * changelog) is a panel definition below, and panel routing lives solely in
 * `contextWorkbenchStore`.
 *
 * The tab *bodies* are unchanged and still lazy-loaded: the canvas bundle stays
 * lean, and unit tests that mount the canvas don't pull the whole chat
 * dependency graph just to assert on the inspector.
 *
 * The chat panel pins the global chat store's `activeSessionId` to a
 * deterministic `workflow:${workflowId}` session via
 * `useWorkflowEditorSession`. That session has `kind: "workflow-editor"` which
 * `resolveSendOptions` keys on (C.6) to inject the workflow subagents +
 * system-prompt snapshot, and which `ChannelList` filters out so the session
 * never leaks into the main DM/team rail.
 */

import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import {
  BlocksIcon,
  BotIcon,
  HistoryIcon,
  ListChecksIcon,
  MessageSquareIcon,
  Loader2Icon,
  PlayIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react"
import type { ReactFlowInstance } from "@xyflow/react"
import { cn } from "@/lib/utils"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { InspectorPanel } from "../inspector-panel"
import { EdgeInspector } from "../edge-inspector"
import { ContextWorkbench } from "@/components/context-workbench/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type {
  ContextPanelDefinition,
  ContextResource,
  ContextWorkbenchPlacement,
} from "@/types/context-workbench"
import { workflowEditorRevision } from "@/lib/workflow/editor/editor-revision"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { revealProposalInChat } from "@/lib/workflow/editor/reveal-proposal"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"

// Lazy-load the chat tab so the canvas bundle stays lean AND so unit
// tests that mount the canvas don't pay the cost of pulling the entire
// chat dependency graph (ai-elements, message renderer, etc.) just to
// assert on the inspector. The chat is only mounted when the user
// actually opens it.
const WorkflowEditorChatTab = lazy(() =>
  import("./chat-tab").then((m) => ({ default: m.WorkflowEditorChatTab }))
)

const TemplatesTab = lazy(() =>
  import("./templates-tab").then((m) => ({ default: m.TemplatesTab }))
)

const ChangelogTab = lazy(() =>
  import("./changelog-tab").then((m) => ({ default: m.ChangelogTab }))
)

const SettingsTab = lazy(() => import("./settings-tab").then((m) => ({ default: m.SettingsTab })))

const RunsTab = lazy(() => import("./runs-tab").then((m) => ({ default: m.RunsTab })))

const ProblemsTab = lazy(() => import("./problems-tab").then((m) => ({ default: m.ProblemsTab })))

interface RightSidebarProps {
  useStore: EditorStore
  className?: string
  onOpenWorkflowSettings?: (tab?: string) => void
  reactFlowInstance?: ReactFlowInstance | null
  onCollapse?: () => void
  /** Reopen the container this sidebar sits in — the dual of `onCollapse`. */
  onEnsureVisible?: () => void
  /** The container has shrunk to the activity rail; drop the panel body. */
  railOnly?: boolean
  placement?: ContextWorkbenchPlacement
}

function WorkflowPanelLoading() {
  const t = useTranslations("workflowEditor.rightSidebar")
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      {t("chatLoading")}
    </div>
  )
}

interface WorkflowPanelRuntime {
  editorRevision: string
  handleOpenSettings: (tab?: string) => void
  /**
   * Bring the chat panel forward and scroll to a proposal card. The changelog
   * tab lives in a different panel, so revealing has to navigate first — its
   * "Reveal" button used to render with no handler at all and simply did
   * nothing when clicked.
   */
  revealProposal: (messageId: string | undefined, proposalId: string) => void
  reactFlowInstance?: ReactFlowInstance | null
  selectedEdgeIds: string[]
  selectedNodeIds: string[]
  useStore: EditorStore
  workflowId: string
  workflowName: string
}

// ContextWorkbench treats `renderer` as a component type. Keep those types
// module-scoped so workflow updates do not remount retained panels.
const WorkflowPanelRuntimeContext = createContext<WorkflowPanelRuntime | null>(null)

function useWorkflowPanelRuntime(): WorkflowPanelRuntime {
  const runtime = useContext(WorkflowPanelRuntimeContext)
  if (!runtime) throw new Error("Workflow panel rendered outside its sidebar host")
  return runtime
}

function WorkflowChatPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <Suspense fallback={<WorkflowPanelLoading />}>
      <WorkflowEditorChatTab
        useStore={runtime.useStore}
        workflowId={runtime.workflowId}
        workflowName={runtime.workflowName}
        onOpenWorkflowSettings={runtime.handleOpenSettings}
      />
    </Suspense>
  )
}

function WorkflowCommentsPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <ContextCommentsPanel
      resource={{ kind: "workflow", id: runtime.workflowId }}
      revision={runtime.editorRevision}
      anchor={
        runtime.selectedNodeIds[0]
          ? {
              kind: "workflow-node",
              nodeId: runtime.selectedNodeIds[0],
              revision: runtime.editorRevision,
            }
          : runtime.selectedEdgeIds[0]
            ? {
                kind: "workflow-edge",
                edgeId: runtime.selectedEdgeIds[0],
                revision: runtime.editorRevision,
              }
            : undefined
      }
    />
  )
}

function WorkflowInspectorPanel() {
  const runtime = useWorkflowPanelRuntime()
  return runtime.selectedNodeIds.length === 0 && runtime.selectedEdgeIds.length > 0 ? (
    <EdgeInspector useStore={runtime.useStore} className="border-l-0" />
  ) : (
    <InspectorPanel useStore={runtime.useStore} className="border-l-0" />
  )
}

function WorkflowProblemsPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <Suspense fallback={<WorkflowPanelLoading />}>
      <ProblemsTab useStore={runtime.useStore} reactFlowInstance={runtime.reactFlowInstance} />
    </Suspense>
  )
}

function WorkflowRunsPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <Suspense fallback={<WorkflowPanelLoading />}>
      <RunsTab
        useStore={runtime.useStore}
        workflowId={runtime.workflowId}
        reactFlowInstance={runtime.reactFlowInstance}
      />
    </Suspense>
  )
}

function WorkflowTemplatesPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <Suspense fallback={<WorkflowPanelLoading />}>
      <TemplatesTab useStore={runtime.useStore} workflowId={runtime.workflowId} />
    </Suspense>
  )
}

function WorkflowSettingsPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <Suspense fallback={<WorkflowPanelLoading />}>
      <SettingsTab useStore={runtime.useStore} />
    </Suspense>
  )
}

function WorkflowChangelogPanel() {
  const runtime = useWorkflowPanelRuntime()
  return (
    <Suspense fallback={<WorkflowPanelLoading />}>
      <ChangelogTab
        useStore={runtime.useStore}
        workflowId={runtime.workflowId}
        onRevealInChat={runtime.revealProposal}
      />
    </Suspense>
  )
}

function WorkflowContextWorkbench({
  useStore,
  className,
  onOpenWorkflowSettings,
  reactFlowInstance,
  onCollapse,
  onEnsureVisible,
  railOnly,
  placement,
}: RightSidebarProps) {
  const workbenchInstanceId = useContextWorkbenchInstanceId("workflow")
  const {
    selectedNodeIds,
    selectedEdgeIds,
    workflowId,
    workflowName,
    editorRevision,
    errorCount,
    warningCount,
    requestedProblemsPanel,
    requestedInspectorPanel,
  } = useStore(
    useShallow((state: EditorState) => ({
      selectedNodeIds: state.selectedNodeIds,
      selectedEdgeIds: state.selectedEdgeIds,
      workflowId: state.baseWorkflow.id,
      workflowName: state.baseWorkflow.name,
      editorRevision: workflowEditorRevision(state),
      errorCount: state.diagnostics?.errorCount ?? 0,
      warningCount: state.diagnostics?.warningCount ?? 0,
      requestedProblemsPanel: state.requestedProblemsPanel ?? false,
      requestedInspectorPanel: state.requestedInspectorPanel ?? false,
    }))
  )
  const scopeKey = `${workbenchInstanceId}::workflow:${workflowId}`
  const unresolvedCommentCount = useContextCommentBadge("workflow", workflowId)
  const layout = useContextWorkbenchStore((state) => state.layouts[scopeKey])
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const previousSelectionCount = useRef(0)
  const inspectorCount = selectedNodeIds.length || selectedEdgeIds.length

  useEffect(() => {
    if (!layout?.activePanelId) navigatePanel(scopeKey, "chat", "narrow")
  }, [layout?.activePanelId, navigatePanel, scopeKey])

  useEffect(() => {
    const previous = previousSelectionCount.current
    previousSelectionCount.current = inspectorCount
    if (previous === 0 && inspectorCount > 0) smartReveal(scopeKey, "inspector", "narrow")
  }, [inspectorCount, scopeKey, smartReveal])

  useEffect(() => {
    if (!requestedProblemsPanel) return
    smartReveal(scopeKey, "problems", "wide")
    useStore.getState().clearRequestedProblemsPanel()
  }, [requestedProblemsPanel, scopeKey, smartReveal, useStore])

  useEffect(() => {
    if (!requestedInspectorPanel) return
    smartReveal(scopeKey, "inspector", "narrow")
    useStore.getState().clearRequestedInspectorPanel()
  }, [requestedInspectorPanel, scopeKey, smartReveal, useStore])

  const handleOpenSettings = useCallback(
    (tab?: string) => {
      navigatePanel(scopeKey, "settings", "wide")
      onOpenWorkflowSettings?.(tab)
    },
    [navigatePanel, onOpenWorkflowSettings, scopeKey]
  )

  const handleRevealProposal = useCallback(
    (messageId: string | undefined, proposalId: string) => {
      // Front the chat panel first: the card lives in the chat stream, and the
      // request usually arrives from the changelog panel next door. The scroll
      // waits a frame so the panel has mounted its content.
      navigatePanel(scopeKey, "chat", "narrow")
      requestAnimationFrame(() => {
        revealProposalInChat({ proposalId, messageId })
      })
    },
    [navigatePanel, scopeKey]
  )

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "chat",
        activity: "ai",
        labelKey: "workflowEditor.rightSidebar.tabs.chat",
        icon: BotIcon,
        order: 10,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        renderer: WorkflowChatPanel,
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.comments",
        icon: MessageSquareIcon,
        order: 15,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        getBadge: () => unresolvedCommentCount,
        renderer: WorkflowCommentsPanel,
      },
      {
        id: "inspector",
        activity: "inspect",
        labelKey: "workflowEditor.rightSidebar.tabs.inspector",
        icon: WrenchIcon,
        order: 20,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        getBadge: () => inspectorCount,
        renderer: WorkflowInspectorPanel,
      },
      {
        id: "problems",
        activity: "inspect",
        labelKey: "workflowEditor.rightSidebar.tabs.problems",
        icon: ListChecksIcon,
        order: 30,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        getBadge: () => errorCount + warningCount,
        renderer: WorkflowProblemsPanel,
      },
      {
        id: "runs",
        activity: "preview-run",
        labelKey: "workflowEditor.rightSidebar.tabs.runs",
        icon: PlayIcon,
        order: 40,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        preferredMode: "wide",
        renderer: WorkflowRunsPanel,
      },
      {
        id: "templates",
        activity: "templates",
        labelKey: "workflowEditor.rightSidebar.tabs.templates",
        icon: BlocksIcon,
        order: 50,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        renderer: WorkflowTemplatesPanel,
      },
      {
        id: "settings",
        activity: "inspect",
        labelKey: "workflowEditor.rightSidebar.tabs.settings",
        icon: SettingsIcon,
        order: 60,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        preferredMode: "wide",
        renderer: WorkflowSettingsPanel,
      },
      {
        id: "changelog",
        activity: "review",
        labelKey: "workflowEditor.rightSidebar.tabs.changelog",
        icon: HistoryIcon,
        order: 70,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        preferredMode: "wide",
        renderer: WorkflowChangelogPanel,
      },
    ],
    [errorCount, inspectorCount, unresolvedCommentCount, warningCount]
  )
  const handleExitFocus = useCallback(() => {
    requestAnimationFrame(() => void reactFlowInstance?.fitView({ padding: 0.2, duration: 0 }))
  }, [reactFlowInstance])

  const resource = useMemo<ContextResource>(
    () => ({
      kind: "workflow",
      workflowId,
      editorRevision,
      selection: {
        kind: "workflow",
        nodeIds: selectedNodeIds,
        edgeIds: selectedEdgeIds,
      },
      capabilities: resolveContextCapabilities({ kind: "workflow" }),
    }),
    [editorRevision, selectedEdgeIds, selectedNodeIds, workflowId]
  )
  const panelRuntime = useMemo<WorkflowPanelRuntime>(
    () => ({
      editorRevision,
      handleOpenSettings,
      revealProposal: handleRevealProposal,
      reactFlowInstance,
      selectedEdgeIds,
      selectedNodeIds,
      useStore,
      workflowId,
      workflowName,
    }),
    [
      editorRevision,
      handleOpenSettings,
      handleRevealProposal,
      reactFlowInstance,
      selectedEdgeIds,
      selectedNodeIds,
      useStore,
      workflowId,
      workflowName,
    ]
  )

  return (
    <WorkflowPanelRuntimeContext.Provider value={panelRuntime}>
      <ContextWorkbench
        workbenchInstanceId={workbenchInstanceId}
        resource={resource}
        panels={panels}
        placement={placement}
        onExitFocus={handleExitFocus}
        onCollapse={onCollapse}
        onEnsureVisible={onEnsureVisible}
        railOnly={railOnly}
        manageOwnWidth={false}
        className={cn("w-full", className)}
      />
    </WorkflowPanelRuntimeContext.Provider>
  )
}

/**
 * Memoized so unrelated editor store mutations (drag positions, runStatus
 * flips, viewport changes) don't re-render the whole panel container. The
 * component subscribes to a narrow slice via `useShallow`, so the only valid
 * re-render triggers are: the slice itself changes, the parent passes a new
 * `useStore` reference (per-workflow store lifecycle), or
 * `onOpenWorkflowSettings` identity changes.
 */
export const RightSidebar = memo(WorkflowContextWorkbench)
