"use client"

/**
 * Right sidebar — Tab container that switches between AI Chat and the
 * Inspector (Phase D.1).
 *
 * - Default tab is **Chat** so opening a workflow drops the user into
 *   an AI co-pilot conversation.
 * - When the canvas selection grows from zero to ≥1 nodes, the active
 *   tab auto-switches to Inspector so the configure form is one click
 *   away from picking a node — matches today's UX where the inspector
 *   "opens" when you click a node.
 * - Manually clicking the Chat tab pins it: subsequent selection
 *   changes do not yank the user away.
 *
 * The Chat tab pins the global chat store's `activeSessionId` to a
 * deterministic `workflow:${workflowId}` session via
 * `useWorkflowEditorSession`. That session has `kind: "workflow-editor"`
 * which `resolveSendOptions` keys on (C.6) to inject the workflow
 * subagents + system-prompt snapshot, and which `ChannelList` filters
 * out so the session never leaks into the main DM/team rail.
 */

import {
  Activity,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { InspectorPanel } from "../inspector-panel"
import { EdgeInspector } from "../edge-inspector"
import { ContextWorkbench } from "@/components/context-workbench/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import { workflowEditorRevision } from "@/lib/workflow/editor/editor-revision"
import { useContextWorkbenchSurfaceFlag } from "@/hooks/context-workbench/use-context-workbench-surface-flag"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"

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

type RightSidebarTab =
  "chat" | "inspector" | "problems" | "templates" | "changelog" | "settings" | "runs"

function RightSidebarInner({
  useStore,
  className,
  onOpenWorkflowSettings,
  reactFlowInstance,
}: {
  useStore: EditorStore
  className?: string
  onOpenWorkflowSettings?: (tab?: string) => void
  reactFlowInstance?: ReactFlowInstance | null
  onCollapse?: () => void
}) {
  const t = useTranslations("workflowEditor.rightSidebar")
  const [tab, setTab] = useState<RightSidebarTab>("chat")
  // Pin the user's explicit choice so selecting a node after a manual
  // "Chat" click doesn't yank them back to the inspector.
  const userPinnedTab = useRef<RightSidebarTab | null>(null)
  // Track the previous selectionCount so the auto-switch only fires on
  // the 0 → ≥1 transition, not every time the count shifts within an
  // already-non-empty selection (e.g. 1 → 2 via shift-click).
  const prevSelectionCountRef = useRef(0)

  const {
    selectionCount,
    edgeSelectionCount,
    workflowId,
    workflowName,
    errorCount,
    warningCount,
    requestedProblemsPanel,
    requestedInspectorPanel,
  } = useStore(
    useShallow((s: EditorState) => ({
      selectionCount: s.selectedNodeIds.length,
      edgeSelectionCount: s.selectedEdgeIds.length,
      workflowId: s.baseWorkflow.id,
      workflowName: s.baseWorkflow.name,
      errorCount: s.diagnostics?.errorCount ?? 0,
      warningCount: s.diagnostics?.warningCount ?? 0,
      requestedProblemsPanel: s.requestedProblemsPanel ?? false,
      requestedInspectorPanel: s.requestedInspectorPanel ?? false,
    }))
  )
  // Inspector shows the node form when nodes are selected, else the edge
  // inspector when only edges are. The tab badge tracks whichever is active.
  const inspectorCount = selectionCount > 0 ? selectionCount : edgeSelectionCount

  // Auto-switch to Inspector when the user picks a node — unless they
  // explicitly pinned Chat. Only fires on the 0 → ≥1 edge: subsequent
  // selection-size changes (1 → 2, 2 → 3) don't re-set the tab and
  // don't yank the user away if they manually moved to chat after the
  // first selection. The opposite direction (selection emptied →
  // switch to Chat) is intentionally not auto: users often clear
  // selection by clicking empty canvas without wanting to leave the
  // inspector mid-edit.
  useEffect(() => {
    const prev = prevSelectionCountRef.current
    prevSelectionCountRef.current = inspectorCount
    if (prev === 0 && inspectorCount > 0 && userPinnedTab.current !== "chat") {
      setTab("inspector")
    }
  }, [inspectorCount])

  // Run gate → "open Problems panel" signal. An explicit user action (a
  // blocked run), so it overrides a pinned tab. Clear the signal once consumed.
  useEffect(() => {
    if (!requestedProblemsPanel) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional bridge from the Zustand requestedProblemsPanel signal into the local tab state.
    setTab("problems")
    useStore.getState().clearRequestedProblemsPanel()
  }, [requestedProblemsPanel, useStore])

  // Explicit configure gesture (node double-click / context-menu "Configure")
  // → reveal the Inspector even over a pinned tab, and drop the pin so
  // subsequent selections resume the normal auto-switch behavior.
  useEffect(() => {
    if (!requestedInspectorPanel) return
    userPinnedTab.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional bridge from the Zustand requestedInspectorPanel signal into the local tab state.
    setTab("inspector")
    useStore.getState().clearRequestedInspectorPanel()
  }, [requestedInspectorPanel, useStore])

  const handleTabChange = (next: string) => {
    const v: RightSidebarTab =
      next === "chat"
        ? "chat"
        : next === "problems"
          ? "problems"
          : next === "templates"
            ? "templates"
            : next === "changelog"
              ? "changelog"
              : next === "settings"
                ? "settings"
                : next === "runs"
                  ? "runs"
                  : "inspector"
    userPinnedTab.current = v
    setTab(v)
  }

  // Deep-link target for the chat tab's "open settings" affordance: switch the
  // local tab to Settings and forward to any external handler.
  const handleOpenSettings = (settingsTab?: string) => {
    userPinnedTab.current = "settings"
    setTab("settings")
    onOpenWorkflowSettings?.(settingsTab)
  }

  return (
    <Tabs
      value={tab}
      onValueChange={handleTabChange}
      className={cn("flex h-full w-full flex-col border-l bg-card/40", className)}
      data-testid="workflow-right-sidebar"
    >
      {/* Single scrollable row: tabs size to their label (flex-none overrides
          the shadcn flex-1) so longer labels — "运行记录" / "Inspector" — never
          clip, and the row scrolls horizontally once it outgrows the narrow
          sidebar instead of squeezing every tab into an unreadable sliver. */}
      <TabsList className="m-2 flex w-auto justify-start gap-0.5 overflow-x-auto">
        <TabsTrigger
          value="chat"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-chat"
        >
          {t("tabs.chat")}
        </TabsTrigger>
        <TabsTrigger
          value="inspector"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-inspector"
        >
          {t("tabs.inspector")}
          {inspectorCount > 1 ? (
            <span className="ml-1 text-[10px] opacity-70">×{inspectorCount}</span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger
          value="problems"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-problems"
        >
          {t("tabs.problems")}
          {errorCount > 0 ? (
            <span
              className="ml-1 rounded bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
              data-testid="workflow-problems-badge-error"
            >
              {errorCount}
            </span>
          ) : warningCount > 0 ? (
            <span
              className="ml-1 rounded bg-amber-500 px-1 text-[10px] font-medium text-white"
              data-testid="workflow-problems-badge-warning"
            >
              {warningCount}
            </span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger
          value="runs"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-runs"
        >
          {t("tabs.runs")}
        </TabsTrigger>
        <TabsTrigger
          value="templates"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-templates"
        >
          {t("tabs.templates")}
        </TabsTrigger>
        <TabsTrigger
          value="settings"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-settings"
        >
          {t("tabs.settings")}
        </TabsTrigger>
        <TabsTrigger
          value="changelog"
          className="flex-none"
          data-testid="workflow-right-sidebar-tab-changelog"
        >
          {t("tabs.changelog")}
        </TabsTrigger>
      </TabsList>
      {/* `forceMount` keeps the chat tab in the DOM across tab switches; */}
      {/* `<Activity>` then pauses its effects + renders while hidden. */}
      {/* Together they (a) cache the heavy Suspense fallback so the user */}
      {/* doesn't see the loading spinner on every tab switch and (b) */}
      {/* preserve scroll position + composer draft state. */}
      {/* Radix never sets the `hidden` attr on force-mounted panels, so */}
      {/* `data-[state=inactive]:hidden` is required: without it the empty */}
      {/* chat panel keeps its `flex-1` share of the column while another */}
      {/* tab is active and squeezes that tab's content into the bottom half. */}
      <TabsContent
        value="chat"
        className="flex-1 m-0 overflow-hidden data-[state=inactive]:hidden"
        forceMount
        data-testid="workflow-right-sidebar-panel-chat"
      >
        <Activity mode={tab === "chat" ? "visible" : "hidden"}>
          <Suspense
            fallback={
              <div
                className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
                data-testid="workflow-chat-tab-suspense"
              >
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                {t("chatLoading")}
              </div>
            }
          >
            <WorkflowEditorChatTab
              useStore={useStore}
              workflowId={workflowId}
              workflowName={workflowName}
              onOpenWorkflowSettings={handleOpenSettings}
            />
          </Suspense>
        </Activity>
      </TabsContent>
      <TabsContent value="inspector" className="flex-1 m-0 overflow-hidden">
        {selectionCount === 0 && edgeSelectionCount > 0 ? (
          <EdgeInspector useStore={useStore} className="border-l-0" />
        ) : (
          <InspectorPanel useStore={useStore} className="border-l-0" />
        )}
      </TabsContent>
      <TabsContent value="templates" className="flex-1 m-0 overflow-hidden">
        <Suspense
          fallback={
            <div
              className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
              data-testid="workflow-templates-tab-suspense"
            >
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {t("chatLoading")}
            </div>
          }
        >
          <TemplatesTab useStore={useStore} workflowId={workflowId} />
        </Suspense>
      </TabsContent>
      <TabsContent value="runs" className="flex-1 m-0 overflow-hidden">
        <Suspense
          fallback={
            <div
              className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
              data-testid="workflow-runs-tab-suspense"
            >
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {t("chatLoading")}
            </div>
          }
        >
          <RunsTab
            useStore={useStore}
            workflowId={workflowId}
            reactFlowInstance={reactFlowInstance}
          />
        </Suspense>
      </TabsContent>
      <TabsContent value="problems" className="flex-1 m-0 overflow-hidden">
        <Suspense
          fallback={
            <div
              className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
              data-testid="workflow-problems-tab-suspense"
            >
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {t("chatLoading")}
            </div>
          }
        >
          <ProblemsTab useStore={useStore} reactFlowInstance={reactFlowInstance} />
        </Suspense>
      </TabsContent>
      <TabsContent value="settings" className="flex-1 m-0 overflow-hidden">
        <Suspense
          fallback={
            <div
              className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
              data-testid="workflow-settings-tab-suspense"
            >
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {t("chatLoading")}
            </div>
          }
        >
          <SettingsTab useStore={useStore} />
        </Suspense>
      </TabsContent>
      <TabsContent value="changelog" className="flex-1 m-0 overflow-hidden">
        <Suspense
          fallback={
            <div
              className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
              data-testid="workflow-changelog-tab-suspense"
            >
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {t("chatLoading")}
            </div>
          }
        >
          <ChangelogTab useStore={useStore} workflowId={workflowId} />
        </Suspense>
      </TabsContent>
    </Tabs>
  )
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

function WorkflowContextWorkbench({
  useStore,
  className,
  onOpenWorkflowSettings,
  reactFlowInstance,
  onCollapse,
}: {
  useStore: EditorStore
  className?: string
  onOpenWorkflowSettings?: (tab?: string) => void
  reactFlowInstance?: ReactFlowInstance | null
  onCollapse?: () => void
}) {
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
        renderer: () => (
          <Suspense fallback={<WorkflowPanelLoading />}>
            <WorkflowEditorChatTab
              useStore={useStore}
              workflowId={workflowId}
              workflowName={workflowName}
              onOpenWorkflowSettings={handleOpenSettings}
            />
          </Suspense>
        ),
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.comments",
        icon: MessageSquareIcon,
        order: 15,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        renderer: () => (
          <ContextCommentsPanel
            resource={{ kind: "workflow", id: workflowId }}
            revision={editorRevision}
            anchor={
              selectedNodeIds[0]
                ? {
                    kind: "workflow-node",
                    nodeId: selectedNodeIds[0],
                    revision: editorRevision,
                  }
                : selectedEdgeIds[0]
                  ? {
                      kind: "workflow-edge",
                      edgeId: selectedEdgeIds[0],
                      revision: editorRevision,
                    }
                  : undefined
            }
          />
        ),
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
        renderer: () =>
          selectedNodeIds.length === 0 && selectedEdgeIds.length > 0 ? (
            <EdgeInspector useStore={useStore} className="border-l-0" />
          ) : (
            <InspectorPanel useStore={useStore} className="border-l-0" />
          ),
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
        renderer: () => (
          <Suspense fallback={<WorkflowPanelLoading />}>
            <ProblemsTab useStore={useStore} reactFlowInstance={reactFlowInstance} />
          </Suspense>
        ),
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
        renderer: () => (
          <Suspense fallback={<WorkflowPanelLoading />}>
            <RunsTab
              useStore={useStore}
              workflowId={workflowId}
              reactFlowInstance={reactFlowInstance}
            />
          </Suspense>
        ),
      },
      {
        id: "templates",
        activity: "templates",
        labelKey: "workflowEditor.rightSidebar.tabs.templates",
        icon: BlocksIcon,
        order: 50,
        appliesTo: (resource) => resource.kind === "workflow",
        retention: "stateful",
        renderer: () => (
          <Suspense fallback={<WorkflowPanelLoading />}>
            <TemplatesTab useStore={useStore} workflowId={workflowId} />
          </Suspense>
        ),
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
        renderer: () => (
          <Suspense fallback={<WorkflowPanelLoading />}>
            <SettingsTab useStore={useStore} />
          </Suspense>
        ),
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
        renderer: () => (
          <Suspense fallback={<WorkflowPanelLoading />}>
            <ChangelogTab useStore={useStore} workflowId={workflowId} />
          </Suspense>
        ),
      },
    ],
    [
      errorCount,
      editorRevision,
      handleOpenSettings,
      inspectorCount,
      reactFlowInstance,
      selectedEdgeIds,
      selectedNodeIds,
      useStore,
      warningCount,
      workflowId,
      workflowName,
    ]
  )
  const handleExitFocus = useCallback(() => {
    requestAnimationFrame(() => void reactFlowInstance?.fitView({ padding: 0.2, duration: 0 }))
  }, [reactFlowInstance])

  const resource: ContextResource = {
    kind: "workflow",
    workflowId,
    editorRevision,
    selection: {
      kind: "workflow",
      nodeIds: selectedNodeIds,
      edgeIds: selectedEdgeIds,
    },
    capabilities: resolveContextCapabilities({ kind: "workflow" }),
  }

  return (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      onExitFocus={handleExitFocus}
      onCollapse={onCollapse}
      manageOwnWidth={false}
      className={cn("w-full", className)}
    />
  )
}

/**
 * Memoized so unrelated editor store mutations (drag positions, runStatus
 * flips, viewport changes) don't re-render the entire 4-tab container.
 * The component already subscribes to a narrow slice via `useShallow`,
 * so the only valid re-render triggers are: the slice itself changes,
 * the parent passes a new `useStore` reference (per-workflow store
 * lifecycle), or `onOpenWorkflowSettings` identity changes.
 */
function RightSidebarHost(props: Parameters<typeof RightSidebarInner>[0]) {
  const enabled = useContextWorkbenchSurfaceFlag("workflow")
  return enabled ? <WorkflowContextWorkbench {...props} /> : <RightSidebarInner {...props} />
}

export const RightSidebar = memo(RightSidebarHost)
