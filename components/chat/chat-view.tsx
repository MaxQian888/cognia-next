"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, MessageCircleMore } from "lucide-react"
import { Composer, type ComposerHandle, type ComposerWorkflowMention } from "./composer"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { ChatHeader } from "./chat-header"
import { ChatColumn } from "./chat-column"
import { CharacterMissingBanner } from "./character-missing-banner"
import { WorkSubmissionNotice } from "./work-submission-notice"
import {
  EmptyChatState,
  type EmptyStateOverride,
  type RecentSessionEntry,
  type WelcomeSection,
} from "./empty-state"
import { WelcomeStats } from "./welcome/welcome-stats"
import { DiagnosticCard, InlineError } from "@/components/error/diagnostic-card"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"
import { MessageList } from "./message-list"
import { CompanionTranscriptMessages } from "./companion-transcript-messages"
import { RunStatusBar } from "./run-status-bar"
import { PlanApprovalDock } from "@/components/agent/plan/plan-approval-dock"
import { PlanTrackerDock } from "@/components/agent/plan/plan-tracker-dock"
import { PlanComposerDock } from "@/components/agent/plan/plan-composer-dock"
import { useRunRecordPersistence } from "@/hooks/chat/use-run-record-persistence"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { useStableCallback } from "@/hooks/ui/use-stable-callback"
import { FollowUpSuggestions } from "./follow-up-suggestions"
import { useStarterSuggestions } from "@/hooks/chat/use-starter-suggestions"
import { Button } from "@/components/ui/button"
import { ExternalAgentSessionPanel } from "@/components/agent/external-agent/session-panel"
import {
  useChatStore,
  useSessionHasMessages,
  useSessionStatus,
  useSessionMessages,
  useSessionErrorMessage,
  useSessionErrorDiagnostic,
  useSessionMessagesLoading,
  useSessionMessagesLoadError,
  useIsAtStreamCap,
} from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useCharacter } from "@/lib/data-hooks/context"
import type { Character, ChatSession, SendContent } from "@cognia/agent-config-types"
import type { RewindFilesResult } from "@/lib/claude/ipc"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"
import { toast } from "sonner"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { mobileTransition } from "@/lib/ui/motion"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { WorkspaceChangesCard } from "./workspace-changes-card"
import { useEffectiveCwd } from "@/hooks/chat/use-effective-cwd"
import { ComputerUsePictureInPicture } from "./computer-use-picture-in-picture"
import { consumePendingChatPrompt } from "@/lib/chat/pending-prompt"
import { hasNoLeakingPii } from "@cognia/redact"
import { useFlowMotion } from "./motion/motion-reveal"
import { isSupportAgentId } from "@/lib/support-agent/context"
import { SupportAgentPanel } from "@/components/support/support-agent-panel"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import {
  getSessionHistoryMode,
  hydrateSessionHistory,
  subscribeSessionHistoryMode,
} from "@/lib/sync/session-history"

/**
 * Attach `node` to a (possibly absent) callback or object ref. Defined at
 * module scope so merging the external composer ref doesn't read as mutating a
 * prop during render (React Compiler `immutability` rule).
 */
function attachRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node)
  else if (ref) (ref as { current: T | null }).current = node
}

function HistoryLoadingIndicator({ label }: { label: string }) {
  const { reduce, durationScale } = useFlowMotion()

  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={mobileTransition("fast")}
      aria-busy="true"
    >
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
      <div className="relative grid size-20 place-items-center" aria-hidden>
        <motion.div
          className="absolute inset-1 rounded-full bg-primary/10 blur-xl"
          animate={
            reduce
              ? { opacity: [0.35, 0.65, 0.35] }
              : { opacity: [0.3, 0.7, 0.3], scale: [0.88, 1.08, 0.88] }
          }
          transition={{
            duration: 1.8 * durationScale,
            ease: "easeInOut",
            repeat: Infinity,
          }}
        />
        <div className="absolute inset-3 rounded-full border border-border/70 bg-background/80 shadow-lg shadow-primary/10 backdrop-blur-sm" />
        <motion.div
          className="absolute inset-3 rounded-full border border-primary/15 border-r-primary/35 border-t-primary/70"
          animate={reduce ? { opacity: [0.45, 1, 0.45] } : { rotate: 360 }}
          transition={{
            duration: (reduce ? 1.4 : 1.6) * durationScale,
            ease: reduce ? "easeInOut" : "linear",
            repeat: Infinity,
          }}
        />
        <motion.div
          className="relative grid size-9 place-items-center rounded-2xl bg-primary/10 text-primary"
          animate={reduce ? undefined : { y: [0, -2, 0], scale: [1, 1.04, 1] }}
          transition={{
            duration: 1.4 * durationScale,
            ease: "easeInOut",
            repeat: Infinity,
          }}
        >
          <MessageCircleMore className="size-4.5" strokeWidth={1.8} />
        </motion.div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground/80" aria-hidden>
          {label}
        </p>
        <div className="flex items-center justify-center gap-1.5" aria-hidden>
          {[0, 1, 2].map((index) => (
            <motion.span
              key={index}
              className="size-1 rounded-full bg-primary/55"
              animate={
                reduce ? { opacity: [0.3, 1, 0.3] } : { opacity: [0.3, 1, 0.3], y: [0, -2, 0] }
              }
              transition={{
                delay: index * 0.12,
                duration: 0.9 * durationScale,
                ease: "easeInOut",
                repeat: Infinity,
              }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  )
}

interface ChatPaneProps {
  activeSession: ChatSession | null
  /**
   * Session this pane is bound to. Defaults to `activeSession?.id`. In the
   * multi-pane workspace each pane passes its own id so a background (split /
   * unfocused-tab) pane reads + streams its own slice rather than the focused
   * projection.
   */
  sessionId?: string
  onSend: (content: SendContent, manifest?: readonly AttachmentManifestEntry[]) => Promise<void>
  onStop: () => Promise<void>
  /** Interrupt the running turn and immediately replay the queued steer. */
  onSteerNow?: () => Promise<void> | void
  /** Replay the queued steer now without a turn boundary (errored/idle queue). */
  onSteerFlush?: () => Promise<void> | void
  onRegenerate: () => Promise<void>
  onEditResend: (messageId: string, newContent: SendContent) => Promise<void>
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  onCompact?: () => Promise<void>
  onSetModel?: (model: string) => Promise<void>
  onResetRuntime?: () => Promise<void>
  onCreate: () => void
  onUseSample: (text: string) => void
  onOpenSettings: (tab?: string) => void
  /** Recent sessions for the welcome page "Continue" group. */
  recentSessions?: readonly RecentSessionEntry[]
  /** Resume a recent session by id from the welcome page. */
  onResumeSession?: (id: string) => void
  /**
   * Imperative handle on the Composer. Both shells hold it to insert
   * `@CharacterName` mentions on behalf of the workbench's team-members panel
   * (`lib/chat/composer-mention-request.ts`).
   */
  composerRef?: Ref<ComposerHandle>
  /** Keep cached history readable while runtime writes are unavailable. */
  composerDisabled?: boolean
  /** When provided, opens the mobile inline @-mention popover on `@`. */
  mobileMentionMembers?: readonly Character[]
  /**
   * Workflow-editor copilot wiring — forwarded to the `<Composer>` so `@`
   * opens a workflow node/edge picker. Only the workflow chat tab passes this.
   */
  workflowMention?: ComposerWorkflowMention
  /**
   * Resume the chat turn after the user approves a plan in the plan-approval
   * dock. The host switches the session permission mode to `mode`
   * (acceptEdits / default / auto) and sends the resume prompt. When omitted
   * the dock is not rendered (e.g. surfaces without a send pipeline).
   */
  onResumeAfterPlanApproval?: (
    prompt: string,
    mode: import("@/components/agent/plan/plan-approval-card").PlanResumeMode
  ) => void | Promise<void>
  /**
   * "Keep planning" feedback channel: send `feedback` as a normal user turn
   * (session stays in plan mode). Optional — keep-planning works without it.
   */
  onSendPlanFeedback?: (feedback: string) => void | Promise<void>
  /** Compact split-view entry action rendered in the focused pane header. */
  onSplitView?: () => void
  /** Compact split-view exit action rendered in the secondary pane header. */
  onExitSplit?: () => void
  /**
   * When false, the internal `<ChatHeader>` is omitted. The Inbox detail
   * panel uses this so its own `<ConversationHeader>` (mode + policy +
   * character chip) is the only header, avoiding duplicate chrome.
   * Defaults to true.
   */
  showHeader?: boolean
  /**
   * Surface-specific overrides for the empty/welcome state (heading, subtitle,
   * and starter cards). The workflow-editor chat tab uses this to swap the
   * generic dev-tool starters for workflow-specific flows.
   */
  emptyState?: EmptyStateOverride
  /**
   * Mobile-home extras injected ONLY into the no-session welcome (the app
   * launch home) — not the empty-active-session state. The mobile shell passes
   * its customizable quick-action grid + active-runs/search header here and
   * suppresses the generic dev-tool starter cards.
   */
  welcomeExtras?: {
    quickActions?: ReactNode
    header?: ReactNode
    hideSamples?: boolean
  }
}

/**
 * The "main pane" content of the desktop shell — header, message list,
 * composer, error/empty states. Owned by `<DesktopChatWorkspace>`, which
 * provides the cross-cutting hooks and dialogs.
 *
 * Kept lean on purpose: every cross-cutting concern (settings, approvals,
 * command palette, title bar) belongs in the shell.
 */
export function ChatPane({
  activeSession,
  sessionId,
  onSend,
  onStop,
  onSteerNow,
  onSteerFlush,
  onRegenerate,
  onEditResend,
  onRewindFiles,
  onCompact,
  onSetModel,
  onResetRuntime,
  onCreate,
  onUseSample,
  onOpenSettings,
  recentSessions,
  onResumeSession,
  composerRef,
  composerDisabled,
  mobileMentionMembers,
  onResumeAfterPlanApproval,
  onSendPlanFeedback,
  onSplitView,
  onExitSplit,
  showHeader = true,
  emptyState,
  welcomeExtras,
  workflowMention,
}: ChatPaneProps) {
  const tCopy = useTranslations("chat.copy")
  const tHistory = useTranslations("chat.history")
  const tConcurrent = useTranslations("chat.concurrent")
  const tInlineErr = useTranslations("chat.inlineError")
  // The pane is bound to its own session slice (defaulting to the focused
  // session) so a background pane reads + streams its own state independently.
  const boundId = sessionId ?? activeSession?.id ?? null
  // Subscribe to a boolean, not the whole `messages` array: the empty/chat
  // layout swap and the focus/retry gates only care whether any message
  // exists. Streaming tokens mutate `messages` but not this boolean, so the
  // chrome (header, composer, footer) no longer re-renders per token — only
  // the inner `ChatMessages` subtree does.
  const hasMessages = useSessionHasMessages(boundId)
  const subscribeHistoryMode = useCallback(
    (listener: () => void) =>
      boundId ? subscribeSessionHistoryMode(boundId, listener) : () => undefined,
    [boundId]
  )
  const getHistoryMode = useCallback(() => getSessionHistoryMode(boundId), [boundId])
  const historyMode = useSyncExternalStore(subscribeHistoryMode, getHistoryMode, () => null)
  const isWebCompanionPane = !isTauri() && !isCapacitor() && hasWebCompanionTarget()
  const usesCompanionTranscript = historyMode === "timeline" && isWebCompanionPane
  const hasHistory = hasMessages || usesCompanionTranscript
  // Snapshot each turn into the durable run-records table (Run Panel "second
  // clock") — runs regardless of whether the panel is expanded or rendered.
  useRunRecordPersistence(boundId)
  const status = useSessionStatus(boundId)
  const errorMessage = useSessionErrorMessage(boundId)
  const errorDiagnostic = useSessionErrorDiagnostic(boundId)
  const messagesLoading = useSessionMessagesLoading(boundId)
  const messagesLoadError = useSessionMessagesLoadError(boundId)
  const coldHistoryLoading = !hasHistory && messagesLoading && !messagesLoadError
  const showHistoryLoader = useDeferredLoading(coldHistoryLoading, { key: boundId })
  const showHistorySurface = coldHistoryLoading || showHistoryLoader
  const atCapacity = useIsAtStreamCap(boundId)
  const reduce = useReducedMotion()
  const isMobile = useIsMobile()

  // Split panes, Workflow Chat and Workbench can bind a session without
  // making it the global activeSessionId. Negotiate per mounted pane so those
  // production routes publish their own timeline/legacy mode. The history
  // module coalesces this with an active-session negotiation already in flight.
  useEffect(() => {
    if (!boundId || !isWebCompanionPane || historyMode !== null) return
    let cancelled = false
    void import("@/lib/tauri/transport-instance")
      .then(({ transport }) => hydrateSessionHistory(transport, boundId))
      .catch((error) => {
        if (cancelled) return
        useChatStore
          .getState()
          .setSessionMessagesLoadError(
            boundId,
            error instanceof Error ? error.message : String(error)
          )
      })
    return () => {
      cancelled = true
    }
  }, [boundId, historyMode, isWebCompanionPane])

  // ADR-0030 — surface the active character's exemplar prompts as quick-start
  // chips on the empty inline state. `useCharacter` resolves Dexie + overlay
  // characters; returns undefined for legacy/unset ids.
  const activeCharacter = useCharacter(activeSession?.characterId)
  const projectRoot = useEffectiveCwd(activeSession)
  const characterSamples = activeCharacter?.persona?.exemplarPrompts
  const aiStarters = useStarterSuggestions(activeSession, {
    name: activeCharacter?.name,
    description: activeCharacter?.description,
  })

  // The composer remounts when the layout swaps from the centered empty state
  // to the docked chat state (the two motion branches mount it at different
  // tree positions). We hold our own ref to the live instance — forwarding to
  // the optional external `composerRef` too — so we can restore keyboard focus
  // once the new instance has mounted (see `onExitComplete` below). Without
  // this, sending the first message of a session drops focus.
  const internalComposerRef = useRef<ComposerHandle | null>(null)
  const setComposerRef = useCallback(
    (node: ComposerHandle | null) => {
      internalComposerRef.current = node
      attachRef(composerRef, node)
    },
    [composerRef]
  )

  // Stable-identity wrappers (not plain useCallback): these three cross the
  // `MessageRenderer` memo comparator for EVERY mounted row. The upstream
  // `onRegenerate`/`onEditResend` props are rebuilt whenever the workspace
  // re-renders (each sessions-liveQuery refresh, i.e. several times per
  // agentic turn), and a dep-keyed useCallback would forward that identity
  // churn and re-reconcile the whole visible list at ~11ms/row.
  const handleCopySuccess = useStableCallback(() => {
    toast.success(tCopy("success"))
  })

  const handleRegenerate = useStableCallback(() => {
    void onRegenerate()
  })

  const handleEditResend = useStableCallback((id: string, newText: string) => {
    void onEditResend(id, newText)
  })

  const handleSend = useCallback(
    async (content: SendContent, manifest?: readonly AttachmentManifestEntry[]) => {
      await onSend(content, manifest)
    },
    [onSend]
  )

  useEffect(() => {
    if (!boundId || status !== "idle" || messagesLoading || activeSession?.kind === "subagent") {
      return
    }
    const pendingPrompt = consumePendingChatPrompt(boundId)
    if (!pendingPrompt) return
    if (!hasNoLeakingPii(pendingPrompt)) {
      toast.error(tInlineErr("pendingPromptPiiBlocked"))
      return
    }
    void handleSend(pendingPrompt)
  }, [activeSession?.kind, boundId, handleSend, messagesLoading, status, tInlineErr])

  const handleRetry = useCallback(async () => {
    if (boundId) useChatStore.getState().setSessionError(boundId, null)
    await onRegenerate()
  }, [onRegenerate, boundId])

  // Re-trigger the Dexie history load after a load failure.
  const handleRetryLoad = useCallback(() => {
    if (boundId) useChatStore.getState().requestSessionMessagesReload(boundId)
  }, [boundId])

  // Welcome-section dismissals (`AppSettings.welcomeHidden`) — the ✕ on a
  // section header persists the flag; Settings → General → Personalization
  // offers the "restore hidden sections" escape hatch.
  const welcomeHidden = useSettingsStore((s) => s.settings?.welcomeHidden)
  const handleDismissSection = useCallback((section: WelcomeSection) => {
    const { settings, save } = useSettingsStore.getState()
    void save({ welcomeHidden: { ...settings?.welcomeHidden, [section]: true } })
  }, [])

  // Usage dashboard — only on the generic chat welcome. Surfaces that replace
  // the welcome copy entirely (the workflow-editor chat tab passes
  // `emptyState`) get their own framing and would read as off-topic with it.
  const statsSlot = emptyState ? undefined : <WelcomeStats />

  if (!activeSession) {
    return (
      <EmptyChatState
        onCreate={onCreate}
        onUseSample={(text) => onUseSample(text)}
        recentSessions={recentSessions}
        onResumeSession={onResumeSession}
        override={emptyState}
        hideSamples={welcomeExtras?.hideSamples}
        headerExtraSlot={welcomeExtras?.header}
        quickActionsSlot={welcomeExtras?.quickActions}
        statsSlot={statsSlot}
        hiddenSections={welcomeHidden}
        onDismissSection={handleDismissSection}
      />
    )
  }

  // One composer instance, always docked at the bottom — below the welcome
  // content (no messages yet) or below the message list once the conversation
  // starts. It remounts across that branch swap; `setComposerRef` re-attaches
  // our ref (and the external one) to the new instance, and `onExitComplete`
  // restores focus to it so the first send doesn't drop the keyboard.
  //
  // `subagent` sessions (ADR-0062) are read-only imported inner transcripts —
  // no composer at all (they have no continuation path).
  const composerEl =
    activeSession?.kind === "subagent" ? null : (
      <Composer
        ref={setComposerRef}
        session={activeSession}
        onStartNewSession={() => onCreate()}
        onOpenSettings={(tab) => onOpenSettings(tab)}
        onSend={handleSend}
        onStop={() => void onStop()}
        status={status}
        // Only the concurrent-stream cap blocks the composer (this pane isn't
        // one of the streamers, so there is nothing to steer). Awaiting approval
        // stays writable on purpose: that is exactly when the user wants to say
        // "don't use that tool, do it another way", and `send` already routes a
        // message in that state into the steer queue rather than a new turn.
        disabled={atCapacity || composerDisabled}
        mobileMentionMembers={mobileMentionMembers}
        workflowMention={workflowMention}
      />
    )

  // Transient run-status layer (timer / interrupt / live tools / steer queue),
  // pinned directly above the composer. Self-hides when idle with no queue.
  const runStatusEl = (
    <ChatColumn>
      <RunStatusBar
        sessionId={boundId}
        onStop={() => void onStop()}
        onSteerNow={onSteerNow ? () => void onSteerNow() : undefined}
        onSteerFlush={onSteerFlush ? () => void onSteerFlush() : undefined}
      />
    </ChatColumn>
  )
  const supportPanel = isSupportAgentId(activeSession.characterId) ? (
    <ChatColumn className="mb-2">
      <SupportAgentPanel sessionId={boundId} />
    </ChatColumn>
  ) : null

  // Error banner + footer plugin slot — identical in both layouts, sitting
  // just above the composer. Only one layout branch mounts at a time.
  const errorAndFooter = (
    <>
      {atCapacity && (
        <ChatColumn className="mb-1">
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <span>{tConcurrent("overCapacity", { max: 3 })}</span>
          </div>
        </ChatColumn>
      )}
      {/* Structured failures render the shared card, which derives its label,
          hint and buttons from the diagnostic's code. The string branch below
          is the fallback for producers not yet migrated. */}
      {errorDiagnostic ? (
        <ChatColumn className="mt-2">
          <DiagnosticCard
            diagnostic={errorDiagnostic}
            handlers={{
              ...(hasHistory ? { retry: () => void handleRetry() } : {}),
              "open-settings": (action) =>
                onOpenSettings(
                  action.kind === "open-settings"
                    ? (action.section as SettingsSectionId)
                    : "providers"
                ),
            }}
            onDismiss={() => boundId && useChatStore.getState().setSessionError(boundId, null)}
          />
        </ChatColumn>
      ) : (
        errorMessage && (
          <ChatColumn className="mt-2">
            <InlineError
              message={errorMessage}
              onRetry={hasHistory ? handleRetry : undefined}
              onOpenSettings={() => onOpenSettings("providers")}
              onDismiss={() => boundId && useChatStore.getState().setSessionError(boundId, null)}
            />
          </ChatColumn>
        )
      )}
      <ChatColumn>
        <PluginExtensionSlot
          point="chat.footer"
          className="flex items-center justify-center gap-2 empty:hidden"
        />
      </ChatColumn>
    </>
  )

  return (
    <>
      {showHeader && (
        <ChatHeader session={activeSession} onSplitView={onSplitView} onExitSplit={onExitSplit} />
      )}
      {/* ADR-0030 — surfaces a destructive Alert when session.characterId
          no longer resolves (plugin disabled, local pack deleted). Renders
          nothing when the character resolves or the id is a plain Dexie
          row that's simply missing. */}
      <ChatColumn className="mt-2">
        <CharacterMissingBanner characterId={activeSession.characterId} onPickAnother={onCreate} />
      </ChatColumn>
      {/* ADR-0123 — explains a turn that was durably accepted but is waiting,
          held offline, or stopped for human recovery. Renders nothing when a
          turn is streaming normally or the feature is off. */}
      <ChatColumn className="mt-2">
        <WorkSubmissionNotice sessionId={activeSession.id} />
      </ChatColumn>
      <ExternalAgentSessionPanel />
      {/* The surface swap (loader / welcome ⇄ transcript) is a crossfade IN
          PLACE, not a reflow. `popLayout` lifts the exiting branch out of the
          flex column for the duration of its exit, so the entering branch owns
          the full height from its very first frame. Under `sync` both `flex-1`
          branches shared the column during the exit, which halved the pane —
          history mounted in the lower half and then snapped to full height when
          the exit finished (messages "appearing in the middle, then at the
          top"). This wrapper is the positioned offset parent that popLayout
          pins the exiting branch against; keep it `relative`. */}
      <div className="relative flex min-h-0 flex-1 flex-col" data-slot="chat-surface-stage">
        <AnimatePresence
          mode="popLayout"
          initial={false}
          onExitComplete={() => {
            // After the centered→docked swap completes the new composer is
            // mounted; pull focus back to it. Only when entering the chat layout
            // (messages present) — not when returning to the empty welcome.
            // Skip on mobile viewports: programmatic focus opens the virtual
            // keyboard, which is disruptive when switching sessions from the nav
            // sheet (the left drawer on mobile).
            if (hasHistory && !isMobile) internalComposerRef.current?.focus()
          }}
        >
          {showHistorySurface || !hasHistory ? (
            <motion.div
              key="empty"
              className="flex min-h-0 flex-1 flex-col"
              // Both surfaces share one motion vocabulary — content rises in
              // (y 8 → 0) and lifts away (y 0 → -6) — so the eye tracks a
              // single upward handoff instead of two unrelated animations.
              // `initial` only fires when this branch REPLACES the transcript
              // (new session / cleared history); the presence root's
              // `initial={false}` keeps the first mount static.
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={mobileTransition("fast")}
            >
              {messagesLoadError && !hasHistory ? (
                // History load failed — surface it with a retry instead of the
                // welcome layout, which would read as silently lost history.
                <div
                  role="alert"
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
                >
                  <AlertTriangle className="size-8 text-destructive" aria-hidden />
                  <p className="text-sm text-muted-foreground">{tHistory("loadError")}</p>
                  <Button variant="outline" size="sm" onClick={handleRetryLoad}>
                    {tHistory("retry")}
                  </Button>
                </div>
              ) : showHistoryLoader ? (
                <HistoryLoadingIndicator label={tHistory("loading")} />
              ) : coldHistoryLoading ? (
                // Keep fast Dexie reads visually quiet. If the wait crosses the
                // anti-flicker threshold, the animated indicator replaces this.
                <div className="min-h-0 flex-1" aria-busy="true" />
              ) : (
                <EmptyChatState
                  onCreate={onCreate}
                  onUseSample={(text) => onUseSample(text)}
                  variant="inline"
                  recentSessions={recentSessions}
                  onResumeSession={onResumeSession}
                  characterSamples={characterSamples}
                  aiSamples={aiStarters}
                  override={emptyState}
                  statsSlot={statsSlot}
                  hiddenSections={welcomeHidden}
                  onDismissSection={handleDismissSection}
                />
              )}
              {errorAndFooter}
              {supportPanel}
              {/* Composer is hidden while history is loading / failed — same as
                the previous layout, where it only mounted with the welcome. */}
              {!messagesLoadError && !showHistorySurface && composerEl}
            </motion.div>
          ) : (
            <motion.div
              key="chat"
              className="flex min-h-0 flex-1 flex-col"
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={mobileTransition("fast")}
            >
              <div className="relative flex min-h-0 flex-1 flex-col" data-computer-use-pip-host>
                <ChatMessages
                  sessionId={boundId}
                  messageDisplayOverride={activeSession?.messageDisplayOverride}
                  directCharacter={activeCharacter ?? null}
                  projectRoot={projectRoot}
                  onCopy={handleCopySuccess}
                  onRegenerate={handleRegenerate}
                  onEditResend={handleEditResend}
                  onRewindFiles={onRewindFiles}
                  useCompanionTranscript={usesCompanionTranscript}
                />
                {boundId && <ComputerUsePictureInPicture sessionId={boundId} />}
              </div>
              <ChatColumn>
                <FollowUpSuggestions session={activeSession} onUseSample={onUseSample} />
              </ChatColumn>
              {errorAndFooter}
              {boundId && onResumeAfterPlanApproval && (
                <ChatColumn>
                  <PlanApprovalDock
                    sessionId={boundId}
                    session={activeSession}
                    onResume={onResumeAfterPlanApproval}
                    onSendPlanFeedback={onSendPlanFeedback}
                  />
                </ChatColumn>
              )}
              {/* Executing/paused plans surface the live tracker in the same slot
                (statuses are mutually exclusive with awaiting_approval). */}
              {boundId && (
                <ChatColumn>
                  <PlanTrackerDock sessionId={boundId} />
                </ChatColumn>
              )}
              {/* Third mutually-exclusive state for this slot: planning, with no
                plan yet — offer to hand-author one (PlanSource "manual"). */}
              {boundId && (
                <ChatColumn>
                  <PlanComposerDock sessionId={boundId} characterId={activeSession?.characterId} />
                </ChatColumn>
              )}
              <ChatColumn>
                <WorkspaceChangesCard session={activeSession} />
              </ChatColumn>
              {supportPanel}
              {runStatusEl}
              {boundId ? (
                <ChatScopeProvider
                  sessionId={boundId}
                  compact={onCompact}
                  setModel={onSetModel}
                  resetRuntime={onResetRuntime}
                >
                  {composerEl}
                </ChatScopeProvider>
              ) : (
                composerEl
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}

/**
 * The only subtree that subscribes to the full `messages` array, so it is the
 * only part of the chat pane that re-renders as streaming tokens arrive. The
 * callbacks are forwarded verbatim (no new closures) to preserve `MessageList`
 * / `MessageRenderer` memo identity.
 */
function ChatMessages({
  sessionId,
  messageDisplayOverride,
  directCharacter,
  projectRoot,
  onCopy,
  onRegenerate,
  onEditResend,
  onRewindFiles,
  useCompanionTranscript,
}: {
  sessionId: string | null
  messageDisplayOverride?: import("@/types/appearance").MessageDisplayPreferences
  directCharacter?: Character | null
  projectRoot?: string | null
  onCopy: () => void
  onRegenerate: () => void
  onEditResend: (messageId: string, newText: string) => void
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  useCompanionTranscript: boolean
}) {
  const messages = useSessionMessages(sessionId)
  const status = useSessionStatus(sessionId)
  if (sessionId && useCompanionTranscript) {
    return (
      <CompanionTranscriptMessages
        sessionId={sessionId}
        messages={messages}
        status={status}
        messageDisplayOverride={messageDisplayOverride}
        directCharacter={directCharacter}
        projectRoot={projectRoot}
        onCopy={onCopy}
        onRegenerate={onRegenerate}
        onEditResend={onEditResend}
        onRewindFiles={onRewindFiles}
      />
    )
  }
  return (
    <MessageList
      messages={messages}
      status={status}
      messageDisplayOverride={messageDisplayOverride}
      paneSessionId={sessionId}
      directCharacter={directCharacter}
      projectRoot={projectRoot}
      onCopy={onCopy}
      onRegenerate={onRegenerate}
      onEditResend={onEditResend}
      onRewindFiles={onRewindFiles}
    />
  )
}
