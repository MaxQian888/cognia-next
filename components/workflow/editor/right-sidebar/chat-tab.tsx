"use client"

/**
 * Chat tab inside the workflow editor's right sidebar (Phase D).
 *
 * Re-uses the existing main-chat ChatPane verbatim — it already wires
 * Composer, MessageList, error banner, etc. We mount it inside a
 * workflow-scoped session that's pinned to `useChatStore.activeSessionId`
 * for the lifetime of the editor (`useWorkflowEditorSession`). When the
 * editor unmounts, the prior active session is restored.
 *
 * The chat tab does NOT instantiate a second Claude Agent SDK session —
 * it reuses the same sidecar dispatch path (`sendPrompt` → IPC →
 * `dispatch/anthropic.mjs`) that main chat uses. The workflow-editor
 * branch in `resolveSendOptions` (Phase C.6) layers the workflow
 * subagents + system-prompt snapshot on every send so the agent has
 * grounding without re-prompting the user.
 *
 * In addition to the generic chat plumbing, this tab provides a
 * `WorkflowEditorProvider` so the workflow-specific composer toolbar
 * (`WorkflowBottomToolbar`) can read the editor store (for selection)
 * and dispatch workflow quick actions (Validate / Explain / Suggest)
 * back through the same `claude.send` path.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ChatPane } from "@/components/chat/chat-view"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { useWorkflowEditorSession } from "@/hooks/chat/use-workflow-editor-session"
import { Loader2Icon, MessageSquareIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { clearMessages } from "@/lib/db/messages"
import { clearSessionSdkLink } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import type { SendContent } from "@/lib/claude/types"
import type { EditorStore } from "@/lib/workflow/editor/store"
import {
  WorkflowEditorProvider,
  type WorkflowEditorContextValue,
  type WorkflowQuickActionKind,
} from "@/lib/workflow/editor/workflow-editor-context"
import { buildQuickActionPrompt } from "@/lib/workflow/editor/quick-action-prompts"
import {
  WORKFLOW_COPILOT_DISPATCH_EVENT,
  buildWorkflowSlashPrompt,
  type WorkflowDispatchEventDetail,
  type WorkflowSlashAction,
} from "@/lib/slash-commands/actions/workflow"
import {
  expandWorkflowMentions,
  snapshotFromEditorState,
} from "@/lib/workflow/editor/mention-expand"

export function WorkflowEditorChatTab({
  useStore,
  workflowId,
  workflowName,
  onOpenWorkflowSettings,
}: {
  /** Per-instance editor store (created by the canvas). */
  useStore: EditorStore
  workflowId: string | undefined
  workflowName: string | undefined
  /** Hook to open the workflow-settings dialog when the composer asks for "settings". */
  onOpenWorkflowSettings?: (tab?: string) => void
}) {
  const t = useTranslations("workflowEditor.chat")
  const { session, loading } = useWorkflowEditorSession(workflowId, workflowName)
  const claude = useClaudeChat()

  const handleSend = useCallback(
    async (content: SendContent) => {
      try {
        // Expand `@node:<id>` / `@edge:<id>` references against the current
        // graph snapshot BEFORE the agent sees them. Falls through any
        // unknown ids verbatim so the agent can flag dangling references.
        const expanded = applyWorkflowMentionExpansion(content, useStore)
        await claude.send(expanded)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [claude, useStore]
  )

  const handleStop = useCallback(async () => {
    await claude.stop()
  }, [claude])

  const handleRegenerate = useCallback(async () => {
    await claude.regenerate()
  }, [claude])

  const handleEditResend = useCallback(
    async (messageId: string, content: SendContent) => {
      await claude.editAndResend(messageId, content)
    },
    [claude]
  )

  const [clearOpen, setClearOpen] = useState(false)
  const handleClearConversation = useCallback(async () => {
    if (!session) return
    try {
      // 1. Delete every Dexie message row keyed to this workflow session.
      await clearMessages(session.id)
      // 2. Drop sdkSessionId so the next send opens a fresh SDK query —
      //    the agent loses all in-context memory of the prior turns.
      await clearSessionSdkLink(session.id)
      // 3. Drop the in-memory mirror so the UI doesn't render stale history.
      useChatStore.getState().setMessages([])
      toast.success(t("clear"))
      setClearOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [session, t])

  // Build the workflow quick-action prompts from the *current* editor
  // state at click time — we read directly via `getState()` so the prompt
  // captures whatever the user just selected, without making the toolbar
  // re-render on every selection change.
  const handleQuickAction = useCallback(
    async (kind: WorkflowQuickActionKind) => {
      const state = useStore.getState()
      const prompt = buildQuickActionPrompt(kind, state)
      if (!prompt) return
      await handleSend(prompt)
    },
    [useStore, handleSend]
  )

  // Listen for slash-command dispatches from anywhere in the app. The
  // event is fired by `lib/slash-commands/actions/workflow.ts` when the
  // user types `/validate`, `/run`, etc. We translate the action into
  // the same prompt-builder + handleSend pathway the quick-action
  // buttons use, so commands and buttons share one execution route.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<WorkflowDispatchEventDetail>).detail
      if (!detail?.action) return
      void dispatchWorkflowAction(detail.action, useStore, handleSend)
    }
    window.addEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, handler)
    return () => {
      window.removeEventListener(WORKFLOW_COPILOT_DISPATCH_EVENT, handler)
    }
  }, [useStore, handleSend])

  const ctxValue = useMemo<WorkflowEditorContextValue>(
    () => ({ useEditorStore: useStore, onQuickAction: handleQuickAction }),
    [useStore, handleQuickAction]
  )

  if (!workflowId) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
        data-testid="workflow-chat-tab-empty"
      >
        <MessageSquareIcon className="size-6 opacity-60" aria-hidden="true" />
        <p>{t("noWorkflow")}</p>
      </div>
    )
  }

  if (loading || !session) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="workflow-chat-tab-loading"
      >
        <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
        <p>{t("loading")}</p>
      </div>
    )
  }

  return (
    <WorkflowEditorProvider value={ctxValue}>
      <div
        className="flex h-full w-full flex-col bg-card/40"
        aria-label={t("ariaLabel", { name: workflowName ?? workflowId })}
        data-testid="workflow-chat-tab"
      >
        <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setClearOpen(true)}
            data-testid="workflow-chat-clear"
            aria-label={t("clear")}
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            <span>{t("clear")}</span>
          </Button>
        </div>
        <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
          <AlertDialogContent data-testid="workflow-chat-clear-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("clearConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("clearConfirmDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="workflow-chat-clear-cancel">
                {t("clearCancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void handleClearConversation()}
                data-testid="workflow-chat-clear-confirm"
              >
                {t("clearConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ChatPane
          activeSession={session}
          onSend={handleSend}
          onStop={handleStop}
          onRegenerate={handleRegenerate}
          onEditResend={handleEditResend}
          onCreate={() => {
            /* New-session button is a no-op here — the workflow-editor session
             * is fixed per workflow. The button is still visible (so muscle
             * memory works) but the click is benign. */
          }}
          onUseSample={(text) => {
            void handleSend({ type: "text", text } as never)
          }}
          onOpenSettings={(tab) => onOpenWorkflowSettings?.(tab)}
          showHeader={false}
        />
      </div>
    </WorkflowEditorProvider>
  )
}

// Re-exported so external callers (alternative chat shells) can resolve
// the workflow store's selected-nodes shape without importing the
// internal store types.
export type { EditorStore }

/**
 * Pure helper that applies workflow @-mention expansion to a SendContent
 * payload. Only the text portions are rewritten; binary attachments pass
 * through. Exported for testing without touching the React component.
 *
 * SendContent is `string | SendContentBlock[]` — handles both shapes.
 */
function applyWorkflowMentionExpansion(content: SendContent, useStore: EditorStore): SendContent {
  const snapshot = snapshotFromEditorState(useStore.getState())
  if (typeof content === "string") {
    return expandWorkflowMentions(content, snapshot)
  }
  return content.map((block) =>
    block.type === "text" ? { ...block, text: expandWorkflowMentions(block.text, snapshot) } : block
  )
}

export { applyWorkflowMentionExpansion }

/**
 * Translate a slash-command dispatch into a `claude.send` payload. Pulled
 * out of the component so unit tests can exercise the prompt-routing
 * pathway without rendering React (the component itself relies on
 * Tauri / Dexie / claude-agent-sdk plumbing).
 */
async function dispatchWorkflowAction(
  action: WorkflowSlashAction,
  useStore: EditorStore,
  send: (content: SendContent) => Promise<void> | void
): Promise<void> {
  switch (action.kind) {
    case "validate":
    case "suggest": {
      const state = useStore.getState()
      const prompt = buildQuickActionPrompt(action.kind, state)
      if (prompt) await send(prompt)
      return
    }
    case "explain": {
      // /explain mirrors the quick-action prompt but tolerates an empty
      // selection when the args carry @-mentions — the mention-expand
      // pass handles @node:id / @edge:id substitution before the chat
      // hook ships it to the agent.
      const state = useStore.getState()
      const prompt = buildQuickActionPrompt("explain", state)
      const suffix = action.args.trim().length > 0 ? `\n\n${action.args}` : ""
      if (prompt) await send(prompt + suffix)
      return
    }
    case "run":
    case "debug":
    case "refactor": {
      const prompt = buildWorkflowSlashPrompt(action)
      if (prompt) await send(prompt)
      return
    }
  }
}

export { dispatchWorkflowAction }
