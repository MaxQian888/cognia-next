"use client"

import { useCallback, useRef, type Ref } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Composer, type ComposerHandle } from "./composer"
import { ChatHeader } from "./chat-header"
import { CharacterMissingBanner } from "./character-missing-banner"
import { EmptyChatState, type EmptyStateOverride, type RecentSessionEntry } from "./empty-state"
import { InlineError } from "./inline-error"
import { MessageList } from "./message-list"
import { Button } from "@/components/ui/button"
import { ExternalAgentSessionPanel } from "@/components/agent/external-agent/session-panel"
import { useChatStore } from "@/stores/chat"
import { useCharacter } from "@/lib/data-hooks/context"
import type { Character, ChatSession, SendContent } from "@/lib/claude/types"
import { toast } from "sonner"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { mobileTransition } from "@/lib/ui/motion"
import { useIsMobile } from "@/hooks/ui/use-mobile"

/**
 * Attach `node` to a (possibly absent) callback or object ref. Defined at
 * module scope so merging the external composer ref doesn't read as mutating a
 * prop during render (React Compiler `immutability` rule).
 */
function attachRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node)
  else if (ref) (ref as { current: T | null }).current = node
}

interface ChatPaneProps {
  activeSession: ChatSession | null
  onSend: (content: SendContent) => Promise<void>
  onStop: () => Promise<void>
  onRegenerate: () => Promise<void>
  onEditResend: (messageId: string, newContent: SendContent) => Promise<void>
  onCreate: () => void
  onUseSample: (text: string) => void
  onOpenSettings: (tab?: string) => void
  /** Navigate to a capability surface from the welcome page (settings deep-link). */
  onNavigate?: (href: string) => void
  /** Recent sessions for the welcome page "Continue" group. */
  recentSessions?: readonly RecentSessionEntry[]
  /** Resume a recent session by id from the welcome page. */
  onResumeSession?: (id: string) => void
  /**
   * Imperative handle on the Composer. The desktop shell uses it to insert
   * `@CharacterName` mentions when the user clicks a row in the team
   * member-list rail.
   */
  composerRef?: Ref<ComposerHandle>
  /** When provided, opens the mobile inline @-mention popover on `@`. */
  mobileMentionMembers?: readonly Character[]
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
  onSend,
  onStop,
  onRegenerate,
  onEditResend,
  onCreate,
  onUseSample,
  onOpenSettings,
  onNavigate,
  recentSessions,
  onResumeSession,
  composerRef,
  mobileMentionMembers,
  showHeader = true,
  emptyState,
}: ChatPaneProps) {
  const tCopy = useTranslations("chat.copy")
  const tHistory = useTranslations("chat.history")
  // Subscribe to a boolean, not the whole `messages` array: the empty/chat
  // layout swap and the focus/retry gates only care whether any message
  // exists. Streaming tokens mutate `messages` but not this boolean, so the
  // chrome (header, composer, footer) no longer re-renders per token — only
  // the inner `ChatMessages` subtree does.
  const hasMessages = useChatStore((s) => s.messages.length > 0)
  const status = useChatStore((s) => s.status)
  const errorMessage = useChatStore((s) => s.errorMessage)
  const messagesLoading = useChatStore((s) => s.messagesLoading)
  const messagesLoadError = useChatStore((s) => s.messagesLoadError)
  const reduce = useReducedMotion()
  const isMobile = useIsMobile()

  // ADR-0030 — surface the active character's exemplar prompts as quick-start
  // chips on the empty inline state. `useCharacter` resolves Dexie + overlay
  // characters; returns undefined for legacy/unset ids.
  const activeCharacter = useCharacter(activeSession?.characterId)
  const characterSamples = activeCharacter?.persona?.exemplarPrompts

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

  const handleCopySuccess = useCallback(() => {
    toast.success(tCopy("success"))
  }, [tCopy])

  const handleRegenerate = useCallback(() => {
    void onRegenerate()
  }, [onRegenerate])

  const handleEditResend = useCallback(
    (id: string, newText: string) => {
      void onEditResend(id, newText)
    },
    [onEditResend]
  )

  const handleSend = useCallback(
    async (content: SendContent) => {
      await onSend(content)
    },
    [onSend]
  )

  const handleRetry = useCallback(async () => {
    useChatStore.getState().setError(null)
    await onRegenerate()
  }, [onRegenerate])

  // Re-trigger the Dexie history load after a load failure.
  const handleRetryLoad = useCallback(() => {
    useChatStore.getState().requestMessagesReload()
  }, [])

  if (!activeSession) {
    return (
      <EmptyChatState
        onCreate={onCreate}
        onUseSample={(text) => onUseSample(text)}
        onNavigate={onNavigate}
        recentSessions={recentSessions}
        onResumeSession={onResumeSession}
        override={emptyState}
      />
    )
  }

  // One composer instance, placed either centered inside the empty state
  // (no messages yet) or docked at the bottom once the conversation starts.
  // It remounts across that transition; `setComposerRef` re-attaches our ref
  // (and the external one) to the new instance, and `onExitComplete` restores
  // focus to it so the first send doesn't drop the keyboard.
  const composerEl = (
    <Composer
      ref={setComposerRef}
      session={activeSession}
      onStartNewSession={() => onCreate()}
      onOpenSettings={(tab) => onOpenSettings(tab)}
      onSend={handleSend}
      onStop={() => void onStop()}
      disabled={status === "awaiting_approval"}
      mobileMentionMembers={mobileMentionMembers}
    />
  )

  // Error banner + footer plugin slot — identical in both layouts, sitting
  // just above the composer. Only one layout branch mounts at a time.
  const errorAndFooter = (
    <>
      {errorMessage && (
        <InlineError
          message={errorMessage}
          onRetry={hasMessages ? handleRetry : undefined}
          onOpenSettings={() => onOpenSettings("api-key")}
          onDismiss={() => useChatStore.getState().setError(null)}
        />
      )}
      <PluginExtensionSlot
        point="chat.footer"
        className="flex items-center justify-center gap-2 px-3 empty:hidden"
      />
    </>
  )

  return (
    <>
      {showHeader && (
        <ChatHeader session={activeSession} onOpenSettings={() => onOpenSettings("api-key")} />
      )}
      {/* ADR-0030 — surfaces a destructive Alert when session.characterId
          no longer resolves (plugin disabled, local pack deleted). Renders
          nothing when the character resolves or the id is a plain Dexie
          row that's simply missing. */}
      <CharacterMissingBanner characterId={activeSession.characterId} onPickAnother={onCreate} />
      <ExternalAgentSessionPanel />
      <AnimatePresence
        mode="wait"
        initial={false}
        onExitComplete={() => {
          // After the centered→docked swap completes the new composer is
          // mounted; pull focus back to it. Only when entering the chat layout
          // (messages present) — not when returning to the empty welcome.
          // Skip on mobile viewports: programmatic focus opens the virtual
          // keyboard, which is disruptive when switching sessions from the nav
          // sheet (the left drawer on mobile).
          if (hasMessages && !isMobile) internalComposerRef.current?.focus()
        }}
      >
        {!hasMessages ? (
          <motion.div
            key="empty"
            className="flex min-h-0 flex-1 flex-col"
            exit={reduce ? undefined : { opacity: 0, y: 16 }}
            transition={mobileTransition("normal")}
          >
            {messagesLoadError ? (
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
            ) : messagesLoading ? (
              // Hydration in flight — a quiet loader avoids flashing the empty
              // welcome state during the session-switch gap.
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
                <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
                <span className="sr-only">{tHistory("loading")}</span>
              </div>
            ) : (
              <EmptyChatState
                onCreate={onCreate}
                onUseSample={(text) => onUseSample(text)}
                variant="inline"
                composerSlot={composerEl}
                onNavigate={onNavigate}
                recentSessions={recentSessions}
                onResumeSession={onResumeSession}
                characterSamples={characterSamples}
                override={emptyState}
              />
            )}
            {errorAndFooter}
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            className="flex min-h-0 flex-1 flex-col"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={mobileTransition("normal")}
          >
            <ChatMessages
              onCopy={handleCopySuccess}
              onRegenerate={handleRegenerate}
              onEditResend={handleEditResend}
            />
            {errorAndFooter}
            {composerEl}
          </motion.div>
        )}
      </AnimatePresence>
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
  onCopy,
  onRegenerate,
  onEditResend,
}: {
  onCopy: () => void
  onRegenerate: () => void
  onEditResend: (messageId: string, newText: string) => void
}) {
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  return (
    <MessageList
      messages={messages}
      status={status}
      onCopy={onCopy}
      onRegenerate={onRegenerate}
      onEditResend={onEditResend}
    />
  )
}
