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

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ChatPane } from "@/components/chat/chat-view"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { useWorkflowEditorSession } from "@/hooks/chat/use-workflow-editor-session"
import { Loader2Icon, MessageSquareIcon } from "lucide-react"
import type { SendContent } from "@/lib/claude/types"
import type { EditorStore } from "@/lib/workflow/editor/store"
import {
  WorkflowEditorProvider,
  type WorkflowEditorContextValue,
  type WorkflowQuickActionKind,
} from "@/lib/workflow/editor/workflow-editor-context"
import { buildQuickActionPrompt } from "@/lib/workflow/editor/quick-action-prompts"

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
        await claude.send(content)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [claude]
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
