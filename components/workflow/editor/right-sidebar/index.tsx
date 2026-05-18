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

import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
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

type RightSidebarTab = "chat" | "inspector"

export function RightSidebar({
  useStore,
  className,
  onOpenWorkflowSettings,
}: {
  useStore: EditorStore
  className?: string
  onOpenWorkflowSettings?: (tab?: string) => void
}) {
  const t = useTranslations("workflowEditor.rightSidebar")
  const [tab, setTab] = useState<RightSidebarTab>("chat")
  // Pin the user's explicit choice so selecting a node after a manual
  // "Chat" click doesn't yank them back to the inspector.
  const userPinnedTab = useRef<RightSidebarTab | null>(null)

  const { selectionCount, workflowId, workflowName } = useStore(
    useShallow((s: EditorState) => ({
      selectionCount: s.selectedNodeIds.length,
      workflowId: s.baseWorkflow.id,
      workflowName: s.baseWorkflow.name,
    }))
  )

  // Auto-switch to Inspector when the user picks a node — unless they
  // explicitly pinned Chat. The opposite direction (selection emptied
  // → switch to Chat) is intentionally not auto: users often clear
  // selection by clicking empty canvas without wanting to leave the
  // inspector mid-edit.
  useEffect(() => {
    if (selectionCount > 0 && userPinnedTab.current !== "chat") {
      setTab("inspector")
    }
  }, [selectionCount])

  const handleTabChange = (next: string) => {
    const v = (next === "chat" ? "chat" : "inspector") as RightSidebarTab
    userPinnedTab.current = v
    setTab(v)
  }

  return (
    <Tabs
      value={tab}
      onValueChange={handleTabChange}
      className={cn("flex h-full w-full flex-col border-l bg-card/40", className)}
      data-testid="workflow-right-sidebar"
    >
      <TabsList className="m-2 grid w-auto grid-cols-2">
        <TabsTrigger value="chat" data-testid="workflow-right-sidebar-tab-chat">
          {t("tabs.chat")}
        </TabsTrigger>
        <TabsTrigger value="inspector" data-testid="workflow-right-sidebar-tab-inspector">
          {t("tabs.inspector")}
          {selectionCount > 1 ? (
            <span className="ml-1 text-[10px] opacity-70">×{selectionCount}</span>
          ) : null}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="flex-1 m-0 overflow-hidden">
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
            workflowId={workflowId}
            workflowName={workflowName}
            onOpenWorkflowSettings={onOpenWorkflowSettings}
          />
        </Suspense>
      </TabsContent>
      <TabsContent value="inspector" className="flex-1 m-0 overflow-hidden">
        <InspectorPanel useStore={useStore} className="border-l-0" />
      </TabsContent>
    </Tabs>
  )
}
