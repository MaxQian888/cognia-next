"use client"

/**
 * Concurrent-chat pane layout. Renders one or two live `ChatPane`s (split
 * view), each bound to its own session slice so
 * sessions stream simultaneously and a focus switch never pauses a background
 * stream. Every pane wires its own send / stop / regenerate / edit; ChatPane
 * owns its session-scoped blocking decisions.
 */

import { useCallback, type ReactNode, type Ref } from "react"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { ChatPane } from "./chat-view"
import type { ComposerHandle, ComposerTurnMetadata } from "./composer"
import type { RecentSessionEntry } from "./empty-state"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { useChatStore } from "@/stores/chat"
import type { ChatSession, SendContent } from "@cognia/agent-config-types"
import type { RewindFilesResult } from "@/lib/claude/ipc"
import type { ChatTemplateRun } from "@/lib/chat/template/run"

export interface ChatPaneGroupProps {
  /** All sessions (for resolving tab titles / character ids). */
  sessions: readonly ChatSession[]
  /** Per-session send — the workspace wraps trust-prompting around it. */
  send: (
    content: SendContent,
    sessionId: string,
    manifest?: readonly AttachmentManifestEntry[],
    templateRun?: ChatTemplateRun | null,
    turnMetadata?: ComposerTurnMetadata
  ) => Promise<void> | void
  stop: (sessionId: string) => Promise<void> | void
  /** Interrupt the running turn and immediately replay the queued steer. */
  steerNow: (sessionId: string) => Promise<void> | void
  /** Replay the queued steer now without a turn boundary (errored/idle queue). */
  steerFlush: (sessionId: string) => Promise<void> | void
  regenerate: (sessionId: string) => Promise<void> | void
  editResend: (messageId: string, content: SendContent, sessionId: string) => Promise<void> | void
  rewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  compact?: (sessionId: string) => Promise<void>
  setModel?: (sessionId: string, model: string) => Promise<void>
  resetRuntime?: (sessionId: string) => Promise<void>
  onCreate: () => void
  /**
   * "Chat as a character" door — opens the character picker. Distinct from
   * `onCreate` (which navigates to the welcome surface): the character-missing
   * banner uses it to offer a replacement pick. Defaults to `onCreate`.
   */
  onPickCharacter?: () => void
  onUseSample: (text: string) => void
  /** First turn from the welcome hero composer — creates the session, then sends. */
  onHeroSend?: (
    content: SendContent,
    manifest?: readonly AttachmentManifestEntry[],
    templateRun?: ChatTemplateRun | null,
    turnMetadata?: ComposerTurnMetadata
  ) => void | Promise<void>
  /** Whether that hero composer may address a runtime — see `ChatPane.heroRouting`. */
  heroRouting?: boolean
  onOpenSettings: (tab?: string) => void
  /** Execution picker rendered on the no-session welcome surface. */
  newChatExecutionControls?: ReactNode
  /** Context bar fused onto the welcome hero composer's top edge (`composer/context-bar.tsx`). */
  welcomeContextBarSlot?: ReactNode
  /** Extra controls prepended into the welcome hero composer's toolbar row. */
  welcomeComposerToolbar?: ReactNode
  recentSessions?: readonly RecentSessionEntry[]
  onResumeSession?: (id: string) => void
  composerRef?: Ref<ComposerHandle>
  /** Disable every pane composer without hiding cached conversation data. */
  composerDisabled?: boolean
  runtimeNotice?: ReactNode
  /** Per-session plan-approval resume (switch mode + send the resume turn). */
  onResumeAfterPlanApproval?: (
    prompt: string,
    mode: import("@/components/agent/plan/plan-approval-card").PlanResumeMode,
    sessionId: string
  ) => Promise<void> | void
}

export function ChatPaneGroup({
  sessions,
  send,
  stop,
  steerNow,
  steerFlush,
  regenerate,
  editResend,
  rewindFiles,
  compact,
  setModel,
  resetRuntime,
  onCreate,
  onPickCharacter,
  onUseSample,
  onHeroSend,
  heroRouting,
  onOpenSettings,
  newChatExecutionControls,
  welcomeContextBarSlot,
  welcomeComposerToolbar,
  recentSessions,
  onResumeSession,
  composerRef,
  composerDisabled,
  runtimeNotice,
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

  // Split only within one workspace. Everything around the panes — artifacts,
  // terminals, source control, the workspace panel — resolves against the single
  // active workspace, so a second pane from another project would render a
  // conversation whose surroundings all describe a different repository.
  const activeWorkspaceId = sessionById(activeSessionId)?.projectId ?? undefined
  const sharesActiveWorkspace = (id: string): boolean =>
    (sessionById(id)?.projectId ?? undefined) === activeWorkspaceId

  // A split pane that points at a no-longer-open session — or at one that the
  // active pane has since left the workspace of — collapses back to a single
  // pane.
  const effectiveSplitId =
    splitSessionId &&
    openSessionIds.includes(splitSessionId) &&
    splitSessionId !== activeSessionId &&
    sharesActiveWorkspace(splitSessionId)
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
        onSend={(content, manifest, templateRun, turnMetadata) =>
          Promise.resolve(
            sessionId ? send(content, sessionId, manifest, templateRun, turnMetadata) : undefined
          )
        }
        onStop={() => Promise.resolve(sessionId ? stop(sessionId) : undefined)}
        onSteerNow={() => Promise.resolve(sessionId ? steerNow(sessionId) : undefined)}
        onSteerFlush={() => Promise.resolve(sessionId ? steerFlush(sessionId) : undefined)}
        onRegenerate={() => Promise.resolve(sessionId ? regenerate(sessionId) : undefined)}
        onEditResend={(id, content) =>
          Promise.resolve(sessionId ? editResend(id, content, sessionId) : undefined)
        }
        onRewindFiles={rewindFiles}
        onCompact={sessionId && compact ? () => compact(sessionId) : undefined}
        onSetModel={sessionId && setModel ? (model) => setModel(sessionId, model) : undefined}
        onResetRuntime={sessionId && resetRuntime ? () => resetRuntime(sessionId) : undefined}
        onCreate={onCreate}
        onPickCharacter={onPickCharacter}
        onUseSample={onUseSample}
        onHeroSend={onHeroSend}
        heroRouting={heroRouting}
        onOpenSettings={onOpenSettings}
        newChatExecutionControls={newChatExecutionControls}
        welcomeContextBarSlot={welcomeContextBarSlot}
        welcomeComposerToolbar={welcomeComposerToolbar}
        onSplitView={onSplitView}
        onExitSplit={onExitSplit}
        recentSessions={recentSessions}
        onResumeSession={onResumeSession}
        composerRef={withComposerRef ? composerRef : undefined}
        composerDisabled={composerDisabled}
        runtimeNotice={runtimeNotice}
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

  // A cross-workspace conversation is not offered as a split target. Picking it
  // from the list still follows into its workspace, which now announces itself.
  const splitTargetId =
    openSessionIds.find((id) => id !== activeSessionId && sharesActiveWorkspace(id)) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {effectiveSplitId ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="50%" minSize="25%" className="flex min-h-0 flex-col">
            {renderPane(activeSessionId, true)}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="50%" minSize="25%" className="flex min-h-0 flex-col">
            {renderPane(effectiveSplitId, false, undefined, () => setSplitSessionId(null))}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {renderPane(
            activeSessionId,
            true,
            splitTargetId ? () => setSplitSessionId(splitTargetId) : undefined
          )}
        </div>
      )}
    </div>
  )
}
