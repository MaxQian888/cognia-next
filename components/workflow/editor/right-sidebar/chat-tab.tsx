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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { ChatPane } from "@/components/chat/chat-view"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import {
  createWorkflowEditorSession,
  isWorkflowEditorSessionId,
  useWorkflowEditorSession,
} from "@/hooks/chat/use-workflow-editor-session"
import { useChatStore } from "@/stores/chat"
import { getDb } from "@/lib/db/schema"
import { listMessages } from "@/lib/db/messages"
import { Loader2Icon, MessageSquareIcon } from "lucide-react"
import { WorkflowSessionBar } from "@/components/workflow/editor/chat/session-bar"
import { StickyProposalBanner } from "@/components/workflow/editor/chat/sticky-proposal-banner"
import { revealProposalInChat } from "@/lib/workflow/editor/reveal-proposal"
import type { ChatSession, SendContent, SendContentBlock } from "@cognia/agent-config-types"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { useMentionableWorkflowElements } from "@/lib/workflow/editor/use-mentionable-workflow-elements"
import type { WorkflowElementRef } from "@/stores/chat/chat-store"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { ComposerTurnMetadata } from "@/components/chat/composer"
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
import { PerfBoundary } from "@/lib/perf"
import { buildWorkflowChatStarters } from "./workflow-chat-starters"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"

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
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  // Copilot ⇄ canvas selector: the composer's `@` / `@node:` / `@edge:` picker
  // reads these elements; picking one stages a reference chip. `onHighlight`
  // pulses the picker's active node on the canvas via the store's transient
  // highlight channel.
  const wfElements = useMentionableWorkflowElements(useStore)
  const workflowMention = useMemo(
    () => ({
      elements: wfElements,
      onHighlight: (ids: string[]) => useStore.getState().setHighlightedNodes(ids),
    }),
    [wfElements, useStore]
  )

  // Keep the canvas reference ring in sync with the staged chips so the user
  // sees which nodes are attached to the next AI turn (a violet ring).
  const referencedWfElements = useChatStore((s) => s.referencedWorkflowElements)
  useEffect(() => {
    const nodeIds = referencedWfElements.filter((r) => r.type === "node").map((r) => r.id)
    useStore.getState().setReferencedNodes(nodeIds)
  }, [referencedWfElements, useStore])

  // Drop staged refs + highlights when the editor unmounts so they never leak
  // into the next session's composer or leave a stale ring on re-open.
  useEffect(() => {
    return () => {
      useStore.getState().setReferencedNodes([])
      useStore.getState().setHighlightedNodes([])
      useChatStore.getState().clearReferencedWorkflowElements()
    }
  }, [useStore])

  // The session bar lets the user spin off / switch additional sessions for
  // this workflow; those mutate the chat store's `activeSessionId`. Track it
  // live so the pane + bar re-render against the chosen session instead of
  // staying pinned to the default `useWorkflowEditorSession` row.
  const showAdditional =
    !!workflowId &&
    !!session &&
    isWorkflowEditorSessionId(selectedSessionId, workflowId) &&
    selectedSessionId !== session.id
  // Resolve the additional session's row (the default row is already in hand).
  const additionalRow = useLiveQuery<ChatSession | undefined>(
    () =>
      showAdditional && selectedSessionId ? getDb().sessions.get(selectedSessionId) : undefined,
    [showAdditional, selectedSessionId]
  )

  // The session the pane actually reads/streams from.
  const effectiveSessionId = showAdditional ? selectedSessionId : (session?.id ?? null)
  // Retry hook: ChatPane's "retry load" bumps this slice nonce.
  const reloadNonce = useChatStore((s) =>
    effectiveSessionId ? (s.sessions[effectiveSessionId]?.messagesReloadNonce ?? 0) : 0
  )

  // Hydrate the active session's history from Dexie on switch / mount. The
  // standalone `/workflows/editor` route does NOT mount `useSessions` (the
  // main shell's hydration owner), so without this the pane would show every
  // session — including freshly-switched additional ones — as blank. The
  // freshly-focused slice already carries `messagesLoading: true` (seeded by
  // `setActiveSession`), so no synchronous loading-set is needed here.
  useEffect(() => {
    if (!effectiveSessionId) return
    const id = effectiveSessionId
    let cancelled = false
    listMessages(id)
      .then((msgs) => {
        if (!cancelled) useChatStore.getState().setSessionMessages(id, msgs)
      })
      .catch((err) => {
        if (!cancelled) {
          useChatStore
            .getState()
            .setSessionMessagesLoadError(id, err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [effectiveSessionId, reloadNonce])

  // Mirror the session bar's create path for the welcome-state + composer
  // "new session" affordances so every entry point behaves identically.
  const handleCreateSession = useCallback(async () => {
    if (!workflowId) return
    try {
      const title = workflowName
        ? t("session.newSuffixed", { name: workflowName })
        : t("session.newDefault")
      const id = await createWorkflowEditorSession(workflowId, title)
      setSelectedSessionId(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [workflowId, workflowName, t])

  const handleSend = useCallback(
    async (
      content: SendContent,
      manifest?: readonly AttachmentManifestEntry[],
      _templateRun?: unknown,
      turnMetadata?: ComposerTurnMetadata
    ) => {
      try {
        // Fold the staged reference chips into the message as `@node:`/`@edge:`
        // tokens, then expand every `@node:<id>` / `@edge:<id>` (typed or
        // staged) against the current graph snapshot BEFORE the agent sees
        // them. Unknown ids fall through verbatim so the agent can flag
        // dangling references. Chips + ring clear once the turn is sent.
        const refs = useChatStore.getState().referencedWorkflowElements
        const withRefs = refs.length > 0 ? prependWorkflowRefs(content, refs) : content
        const expanded = applyWorkflowMentionExpansion(withRefs, useStore)
        await claude.send(expanded, undefined, {
          sessionId: effectiveSessionId ?? undefined,
          attachmentManifest: manifest,
          ...(turnMetadata?.webSearchContext
            ? { webSearchContext: turnMetadata.webSearchContext }
            : {}),
        })
        if (refs.length > 0) {
          useChatStore.getState().clearReferencedWorkflowElements()
          useStore.getState().setReferencedNodes([])
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [claude, effectiveSessionId, useStore]
  )

  const handleStop = useCallback(async () => {
    await claude.stop(effectiveSessionId ?? undefined)
  }, [claude, effectiveSessionId])

  const handleRegenerate = useCallback(async () => {
    await claude.regenerate(effectiveSessionId ?? undefined)
  }, [claude, effectiveSessionId])

  const handleEditResend = useCallback(
    async (messageId: string, content: SendContent) => {
      await claude.editAndResend(messageId, content, effectiveSessionId ?? undefined)
    },
    [claude, effectiveSessionId]
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

  // Workflow-specific welcome copy + starter cards for the empty chat state,
  // in place of the generic dev-tool starters the main chat shows.
  const paneRef = useRef<HTMLDivElement | null>(null)
  // Reveal handler for the sticky banner. The banner is deliberately agnostic
  // about how to reach the card; this side knows the pane it lives in, so the
  // lookup is scoped to it rather than the whole document.
  const handleRevealProposal = useCallback((proposalId: string) => {
    revealProposalInChat({ proposalId, root: paneRef.current })
  }, [])

  const emptyState = useMemo(
    () => ({
      title: t("starters.title"),
      subtitle: t("starters.subtitle"),
      samplesHeading: t("starters.heading"),
      samples: buildWorkflowChatStarters(t),
    }),
    [t]
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

  // The session the pane binds to: the store's active additional session when
  // one is focused (falling back to a lightweight placeholder while its Dexie
  // row hydrates so the pane never flashes the default's messages), else the
  // pinned default row.
  const activeSession: ChatSession = showAdditional
    ? (additionalRow ?? {
        id: selectedSessionId as string,
        title: "",
        kind: "workflow-editor",
        createdAt: 0,
        updatedAt: 0,
      })
    : session

  return (
    <ChatScopeProvider sessionId={activeSession.id}>
      <WorkflowEditorProvider value={ctxValue}>
        <PerfBoundary id="workflow:chat-tab">
          <div
            ref={paneRef}
            className="flex h-full w-full flex-col bg-card/40"
            aria-label={t("ariaLabel", { name: workflowName ?? workflowId })}
            data-testid="workflow-chat-tab"
          >
            <WorkflowSessionBar
              workflowId={workflowId}
              workflowName={workflowName}
              activeSessionId={activeSession.id}
              onSwitchSession={setSelectedSessionId}
              onCreateSession={setSelectedSessionId}
            />
            <StickyProposalBanner workflowId={workflowId} onRevealInChat={handleRevealProposal} />
            <ChatPane
              activeSession={activeSession}
              sessionId={activeSession.id}
              onSend={handleSend}
              onStop={handleStop}
              onRegenerate={handleRegenerate}
              onEditResend={handleEditResend}
              onCreate={() => void handleCreateSession()}
              onUseSample={(text) => void handleSend(text)}
              onOpenSettings={(tab) => onOpenWorkflowSettings?.(tab)}
              showHeader={false}
              emptyState={emptyState}
              workflowMention={workflowMention}
            />
          </div>
        </PerfBoundary>
      </WorkflowEditorProvider>
    </ChatScopeProvider>
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
/**
 * Prepend the staged workflow-reference chips to the outgoing message as
 * `@node:<id>` / `@edge:<id>` tokens so {@link applyWorkflowMentionExpansion}
 * turns them into self-contained citations the agent can ground on. Merges into
 * the first text block (or the string) so no empty leading block is created.
 * Exported for unit testing without rendering the component.
 */
function prependWorkflowRefs(content: SendContent, refs: WorkflowElementRef[]): SendContent {
  const tokens = refs.map((r) => `@${r.type}:${r.id}`).join(" ")
  const prefix = `Referring to these workflow elements: ${tokens}\n\n`
  if (typeof content === "string") return prefix + content
  const idx = content.findIndex((b) => b.type === "text")
  if (idx >= 0) {
    const next = content.slice()
    const block = next[idx] as Extract<SendContentBlock, { type: "text" }>
    next[idx] = { ...block, text: prefix + block.text }
    return next
  }
  return [{ type: "text", text: prefix } as SendContentBlock, ...content]
}

export { prependWorkflowRefs }

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
    case "refactor":
    case "delegate": {
      const prompt = buildWorkflowSlashPrompt(action)
      if (prompt) await send(prompt)
      return
    }
  }
}

export { dispatchWorkflowAction }
