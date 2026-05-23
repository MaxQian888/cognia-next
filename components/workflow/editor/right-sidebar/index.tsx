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

import { Activity, lazy, memo, Suspense, useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import type { ReactFlowInstance } from "@xyflow/react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { InspectorPanel } from "../inspector-panel"

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

type RightSidebarTab = "chat" | "inspector" | "templates" | "changelog" | "settings" | "runs"

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

  const { selectionCount, workflowId, workflowName } = useStore(
    useShallow((s: EditorState) => ({
      selectionCount: s.selectedNodeIds.length,
      workflowId: s.baseWorkflow.id,
      workflowName: s.baseWorkflow.name,
    }))
  )

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
    prevSelectionCountRef.current = selectionCount
    if (prev === 0 && selectionCount > 0 && userPinnedTab.current !== "chat") {
      setTab("inspector")
    }
  }, [selectionCount])

  const handleTabChange = (next: string) => {
    const v: RightSidebarTab =
      next === "chat"
        ? "chat"
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
      <TabsList className="m-2 grid w-auto grid-cols-6">
        <TabsTrigger value="chat" data-testid="workflow-right-sidebar-tab-chat">
          {t("tabs.chat")}
        </TabsTrigger>
        <TabsTrigger value="inspector" data-testid="workflow-right-sidebar-tab-inspector">
          {t("tabs.inspector")}
          {selectionCount > 1 ? (
            <span className="ml-1 text-[10px] opacity-70">×{selectionCount}</span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="runs" data-testid="workflow-right-sidebar-tab-runs">
          {t("tabs.runs")}
        </TabsTrigger>
        <TabsTrigger value="templates" data-testid="workflow-right-sidebar-tab-templates">
          {t("tabs.templates")}
        </TabsTrigger>
        <TabsTrigger value="settings" data-testid="workflow-right-sidebar-tab-settings">
          {t("tabs.settings")}
        </TabsTrigger>
        <TabsTrigger value="changelog" data-testid="workflow-right-sidebar-tab-changelog">
          {t("tabs.changelog")}
        </TabsTrigger>
      </TabsList>
      {/* `forceMount` keeps the chat tab in the DOM across tab switches; */}
      {/* `<Activity>` then pauses its effects + renders while hidden. */}
      {/* Together they (a) cache the heavy Suspense fallback so the user */}
      {/* doesn't see the loading spinner on every tab switch and (b) */}
      {/* preserve scroll position + composer draft state. */}
      <TabsContent value="chat" className="flex-1 m-0 overflow-hidden" forceMount>
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
        <InspectorPanel useStore={useStore} className="border-l-0" />
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

/**
 * Memoized so unrelated editor store mutations (drag positions, runStatus
 * flips, viewport changes) don't re-render the entire 4-tab container.
 * The component already subscribes to a narrow slice via `useShallow`,
 * so the only valid re-render triggers are: the slice itself changes,
 * the parent passes a new `useStore` reference (per-workflow store
 * lifecycle), or `onOpenWorkflowSettings` identity changes.
 */
export const RightSidebar = memo(RightSidebarInner)
