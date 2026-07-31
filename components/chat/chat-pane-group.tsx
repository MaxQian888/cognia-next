"use client"

/**
 * Concurrent-chat pane layout. Renders one or two live `ChatPane`s (split
 * view), each bound to its own session slice so
 * sessions stream simultaneously and a focus switch never pauses a background
 * stream. Every pane wires its own send / stop / regenerate / edit + an inline
 * tool-approval gate scoped to that session — a gate in pane B can never block
 * or be confused with pane A's.
 */

import { useCallback, type Ref } from "react"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { ChatPane } from "./chat-view"
import { ToolApprovalDialog } from "./tool-approval-dialog"
import type { ComposerHandle } from "./composer"
import type { RecentSessionEntry } from "./empty-state"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { useChatStore, useSessionPendingApprovals } from "@/stores/chat"
import type {
  ApprovalDecision,
  Character,
  ChatSession,
  SendContent,
} from "@cognia/agent-config-types"

export interface ChatPaneGroupProps {
  /** All sessions (for resolving tab titles / character ids). */
  sessions: readonly ChatSession[]
  /** Per-session send — the workspace wraps trust-prompting around it. */
  send: (
    content: SendContent,
    sessionId: string,
    manifest?: readonly AttachmentManifestEntry[]
  ) => Promise<void> | void
  stop: (sessionId: string) => Promise<void> | void
  /** Interrupt the running turn and immediately replay the queued steer. */
  steerNow: (sessionId: string) => Promise<void> | void
  /** Replay the queued steer now without a turn boundary (errored/idle queue). */
  steerFlush: (sessionId: string) => Promise<void> | void
  regenerate: (sessionId: string) => Promise<void> | void
  editResend: (messageId: string, content: SendContent, sessionId: string) => Promise<void> | void
  respondToApproval: (
    approval: import("@cognia/agent-config-types").PendingApproval,
    decision: ApprovalDecision
  ) => Promise<void> | void
  onCreate: () => void
  onUseSample: (text: string) => void
  onOpenSettings: (tab?: string) => void
  recentSessions?: readonly RecentSessionEntry[]
  onResumeSession?: (id: string) => void
  composerRef?: Ref<ComposerHandle>
  /** Disable every pane composer without hiding cached conversation data. */
  composerDisabled?: boolean
  mobileMentionMembers?: readonly Character[]
  /** Per-session plan-approval resume (switch mode + send the resume turn). */
  onResumeAfterPlanApproval?: (
    prompt: string,
    mode: import("@/components/agent/plan/plan-approval-card").PlanResumeMode,
    sessionId: string
  ) => Promise<void> | void
}

/** Inline, session-scoped approval gate for one pane. */
function PaneApprovalGate({
  sessionId,
  onRespond,
}: {
  sessionId: string
  onRespond: (
    approval: import("@cognia/agent-config-types").PendingApproval,
    decision: ApprovalDecision
  ) => Promise<void> | void
}) {
  const approvals = useSessionPendingApprovals(sessionId)
  // Prefer the first LIVE approval — a fresh answerable request must never be
  // hidden behind a stale interrupted notice. Interrupted entries surface only
  // when nothing is answerable (Dismiss-only card in the dialog).
  const approval = approvals.find((a) => a.status !== "interrupted") ?? approvals[0] ?? null
  return (
    <ToolApprovalDialog
      approval={approval}
      onRespond={(decision) => onRespond(approval!, decision)}
      onDismiss={() =>
        approval && useChatStore.getState().clearApproval(approval.requestId, sessionId)
      }
      onCancelRun={(runId) => {
        // Abort the whole dispatched subagent run (distinct from deny-one).
        void import("@/lib/claude/agents/cancel-subagent").then(({ cancelSubagentRun }) =>
          cancelSubagentRun(runId)
        )
      }}
    />
  )
}

export function ChatPaneGroup({
  sessions,
  send,
  stop,
  steerNow,
  steerFlush,
  regenerate,
  editResend,
  respondToApproval,
  onCreate,
  onUseSample,
  onOpenSettings,
  recentSessions,
  onResumeSession,
  composerRef,
  composerDisabled,
  mobileMentionMembers,
  onResumeAfterPlanApproval,
}: ChatPaneGroupProps) {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const openSessionIds = useChatStore((s) => s.openSessionIds)
  const splitSessionId = useChatStore((s) => s.splitSessionId)
  const setSplitSessionId = useChatStore((s) => s.setSplitSessionId)

  const sessionById = useCallback(
    (id: string | null): ChatSession | null =>
      id ? (sessions.find((s) => s.id === id) ?? null) : null,
    [sessions]
  )

  // A split pane that points at a no-longer-open session collapses back to a
  // single pane.
  const effectiveSplitId =
    splitSessionId && openSessionIds.includes(splitSessionId) && splitSessionId !== activeSessionId
      ? splitSessionId
      : null

  const renderPane = (
    sessionId: string | null,
    withComposerRef: boolean,
    onSplitView?: () => void,
    onExitSplit?: () => void
  ) => {
    const session = sessionById(sessionId)
    return (
      <ChatPane
        sessionId={sessionId ?? undefined}
        activeSession={session}
        onSend={(content, manifest) =>
          Promise.resolve(sessionId ? send(content, sessionId, manifest) : undefined)
        }
        onStop={() => Promise.resolve(sessionId ? stop(sessionId) : undefined)}
        onSteerNow={() => Promise.resolve(sessionId ? steerNow(sessionId) : undefined)}
        onSteerFlush={() => Promise.resolve(sessionId ? steerFlush(sessionId) : undefined)}
        onRegenerate={() => Promise.resolve(sessionId ? regenerate(sessionId) : undefined)}
        onEditResend={(id, content) =>
          Promise.resolve(sessionId ? editResend(id, content, sessionId) : undefined)
        }
        onCreate={onCreate}
        onUseSample={onUseSample}
        onOpenSettings={onOpenSettings}
        onSplitView={onSplitView}
        onExitSplit={onExitSplit}
        recentSessions={recentSessions}
        onResumeSession={onResumeSession}
        composerRef={withComposerRef ? composerRef : undefined}
        composerDisabled={composerDisabled}
        mobileMentionMembers={mobileMentionMembers}
        onResumeAfterPlanApproval={
          onResumeAfterPlanApproval && sessionId
            ? (prompt, mode) => onResumeAfterPlanApproval(prompt, mode, sessionId)
            : undefined
        }
        // "Keep planning" feedback rides the pane's normal send pipeline: a
        // regular user turn with a bubble, session row untouched (still plan).
        onSendPlanFeedback={
          sessionId ? (feedback) => Promise.resolve(send(feedback, sessionId)) : undefined
        }
      />
    )
  }

  const splitTargetId = openSessionIds.find((id) => id !== activeSessionId) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {effectiveSplitId ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="50%" minSize="25%" className="flex min-h-0 flex-col">
            {renderPane(activeSessionId, true)}
            {activeSessionId && (
              <PaneApprovalGate sessionId={activeSessionId} onRespond={respondToApproval} />
            )}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="50%" minSize="25%" className="flex min-h-0 flex-col">
            {renderPane(effectiveSplitId, false, undefined, () => setSplitSessionId(null))}
            <PaneApprovalGate sessionId={effectiveSplitId} onRespond={respondToApproval} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {renderPane(
            activeSessionId,
            true,
            splitTargetId ? () => setSplitSessionId(splitTargetId) : undefined
          )}
          {activeSessionId && (
            <PaneApprovalGate sessionId={activeSessionId} onRespond={respondToApproval} />
          )}
        </div>
      )}
    </div>
  )
}
