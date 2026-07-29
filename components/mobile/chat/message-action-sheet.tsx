"use client"

/**
 * Mobile bottom sheet for per-message actions (Wave 1.7).
 *
 * Triggered by long-press on a message row in the mobile shell. Provides
 * copy / quote / share / branch, plus — when the parent supplies the
 * handlers — Regenerate (last assistant reply; the hover-only footer
 * controls in `message-renderer` are invisible on touch) and Delete
 * (confirmed destructive; the parent owns the store + Dexie + desktop
 * mirror fan-out).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  BookmarkIcon,
  CopyIcon,
  GitBranchIcon,
  Loader2Icon,
  PencilIcon,
  QuoteIcon,
  RefreshCcwIcon,
  LinkIcon,
  Share2Icon,
  SquareIcon,
  Trash2Icon,
  Volume2Icon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
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
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useReadAloudStatus } from "@/hooks/media/use-read-aloud-status"
import { share } from "@/lib/capacitor/share"
import { notify, selectionFeedback } from "@/lib/capacitor/haptics"
import { buildMessagePermalink } from "@/lib/chat/message-permalink"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { speakChatMessage } from "@/lib/tts/speak-chat-message"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { BranchDialog } from "@/components/chat/branch-dialog"
import { BranchNavigator } from "@/components/chat/branch-navigator"
import { UsageBreakdown } from "@/components/chat/usage-breakdown"
import { dispatchComposerAppend } from "@/components/chat/composer"
import type { UsageInfo } from "@/lib/claude/adapter"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { CharacterVoiceSource } from "@/lib/plugin/character-pack/character-voice"

export interface MessageActionSheetProps {
  message: UIMessage | null
  onOpenChange: (next: boolean) => void
  /**
   * Re-run the last assistant turn. Only pass when `message` IS the last
   * assistant message and no turn is in flight — the row renders iff set.
   */
  onRegenerate?: () => void | Promise<void>
  /**
   * Remove the message everywhere (store + local Dexie + desktop mirror).
   * The row renders iff set; the sheet adds the confirm step.
   */
  onDelete?: (message: UIMessage) => void | Promise<void>
  /**
   * Edit the message text and resend from that point. Only pass for the
   * user's own messages while no turn is in flight — the row renders iff
   * set. This is the touch path for the hover-only pencil in
   * `message-renderer`, which is unreachable on mobile.
   */
  onEditResend?: (message: UIMessage, newText: string) => void | Promise<void>
  /**
   * The character that spoke this message (team sender or the session's
   * 1:1 character) — drives the per-character voice of the Read-aloud row.
   * The row itself renders for assistant messages when TTS is enabled.
   */
  character?: CharacterVoiceSource | null
}

export function MessageActionSheet({
  message,
  onOpenChange,
  onRegenerate,
  onDelete,
  onEditResend,
  character,
}: MessageActionSheetProps) {
  const t = useTranslations("mobile.messageActions")
  const tCommon = useTranslations("common")
  const open = message !== null
  // Android hardware / browser back closes the sheet instead of navigating.
  useBackDismiss(open, () => onOpenChange(false))
  // `busy` is always reset in the action handlers' try/finally below;
  // no separate effect needed to clear it on close.
  const [busy, setBusy] = useState(false)
  const [branchTarget, setBranchTarget] = useState<{
    sessionId: string
    messageId: string
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // `null` = action-list mode; a string = edit mode holding the draft text.
  // Reset on every close so a reopened sheet always starts at the list.
  const [editText, setEditText] = useState<string | null>(null)

  // Touch path for the hover-only footer controls in `message-renderer`
  // (bookmark toggle, read-aloud, branch prev/next) — all unreachable on
  // mobile without these rows.
  const ttsEnabled = useSettingsStore((s) => s.settings?.ttsEnabled ?? false)
  const isBookmarked = useChatStore((s) =>
    message ? s.bookmarkedIds.includes(message.id) : false
  )
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)
  const { isActive: readAloudActive, isLoading: readAloudLoading } = useReadAloudStatus(
    message?.id ?? ""
  )

  const text = message ? extractPlainText(message) : ""
  // Per-message token/cost — on desktop this lives in the hover-only action bar
  // (unreachable on touch), so surface it here as a non-interactive footer.
  const usage = (message?.metadata as { usage?: UsageInfo } | undefined)?.usage
  const branchSessionId =
    message && typeof (message.metadata as { sessionId?: unknown } | undefined)?.sessionId === "string"
      ? ((message.metadata as { sessionId?: string }).sessionId as string)
      : undefined

  const onBranch = () => {
    if (!message || !branchSessionId) return
    setBranchTarget({ sessionId: branchSessionId, messageId: message.id })
    onOpenChange(false)
  }

  const onCopy = async () => {
    if (!text) return
    setBusy(true)
    try {
      await writeClipboardText(text)
      void notify("success")
      toast.success(t("copySuccess"))
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("copyFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A permalink back into THIS app, not a published share link — the row below
   * sits next to "Share…" and the two must not be confused.
   */
  const onCopyLink = async () => {
    if (!message || !branchSessionId) return
    setBusy(true)
    try {
      await writeClipboardText(
        buildMessagePermalink({ sessionId: branchSessionId, messageId: message.id })
      )
      void notify("success")
      toast.success(t("copyLinkSuccess"))
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("copyFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onQuote = () => {
    if (!text) return
    // Build a markdown blockquote from the message body and drop it into the
    // composer draft via the existing append bridge (composer.tsx). No new IPC
    // needed — the user then types their reply under the quote and sends.
    const quoted = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    // Addressed to the message's own session so a split pane / sidechat
    // composer never mirrors the quote.
    dispatchComposerAppend({ text: `${quoted}\n\n`, sessionId: branchSessionId })
    void selectionFeedback()
    onOpenChange(false)
  }

  const onRegenerateRow = () => {
    if (!onRegenerate) return
    void onRegenerate()
    onOpenChange(false)
  }

  const onEditSubmit = async () => {
    if (!message || !onEditResend || editText === null) return
    const trimmed = editText.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await onEditResend(message, trimmed)
      setEditText(null)
      onOpenChange(false)
    } catch (err) {
      toast.error(t("editFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onDeleteConfirmed = async () => {
    if (!message || !onDelete) return
    setConfirmDelete(false)
    setBusy(true)
    try {
      await onDelete(message)
      void notify("success")
      toast.success(t("deleteSuccess"))
      onOpenChange(false)
    } catch (err) {
      void notify("error")
      toast.error(t("deleteFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const onShare = async () => {
    if (!text) return
    setBusy(true)
    try {
      const out = await share({ text, dialogTitle: t("shareDialogTitle") })
      if (out.kind === "shared") {
        void notify("success")
        onOpenChange(false)
      } else if (out.kind === "unsupported") {
        void notify("error")
        toast.error(t("shareUnsupported"))
      } else if (out.kind === "error") {
        void notify("error")
        toast.error(t("shareFailed", { message: out.message }))
      }
      // cancelled — silent.
    } finally {
      setBusy(false)
    }
  }

  const onBookmark = () => {
    if (!message) return
    toggleBookmark(message.id)
    void selectionFeedback()
    onOpenChange(false)
  }

  const onReadAloud = () => {
    if (!message || !text) return
    void selectionFeedback()
    if (readAloudActive) {
      ttsOrchestrator.stop()
      onOpenChange(false)
      return
    }
    // Fire-and-forget like `ReadAloudButton` — progress surfaces in the
    // global TtsNowPlayingBar, so the sheet can close immediately.
    void speakChatMessage({ messageId: message.id, text, character }).catch(() => {
      void notify("error")
    })
    onOpenChange(false)
  }

  return (
    <>
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) setEditText(null)
        onOpenChange(next)
      }}
    >
      <DrawerContent data-testid="message-action-sheet">
        <DrawerHeader>
          <DrawerTitle>{t("title")}</DrawerTitle>
          <DrawerDescription>{t("description")}</DrawerDescription>
        </DrawerHeader>
        {editText !== null ? (
          <div className="flex flex-col gap-3 p-4 pb-8" data-testid="message-action-edit-pane">
            <Textarea
              aria-label={t("editInputAria")}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              disabled={busy}
              rows={5}
              // 16px floor avoids the iOS focus auto-zoom path.
              className="max-h-48 text-base"
              data-testid="message-action-edit-input"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditText(null)}
                disabled={busy}
                data-testid="message-action-edit-cancel"
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => void onEditSubmit()}
                disabled={busy || !editText.trim()}
                data-testid="message-action-edit-send"
              >
                {t("editResend")}
              </Button>
            </div>
          </div>
        ) : (
        <StaggeredRows>
          <Row
            icon={<CopyIcon className="size-4" />}
            label={t("copy")}
            onClick={onCopy}
            disabled={busy || !text}
            testid="message-action-copy"
          />
          <Row
            icon={<QuoteIcon className="size-4" />}
            label={t("quote")}
            onClick={onQuote}
            disabled={busy || !text}
            testid="message-action-quote"
          />
          <Row
            icon={<Share2Icon className="size-4" />}
            label={t("share")}
            onClick={onShare}
            disabled={busy || !text}
            testid="message-action-share"
          />
          <Row
            icon={<LinkIcon className="size-4" />}
            label={t("copyLink")}
            onClick={onCopyLink}
            disabled={busy || !message || !branchSessionId}
            testid="message-action-copy-link"
          />
          <Row
            icon={
              <BookmarkIcon className={isBookmarked ? "size-4 fill-current text-yellow-500" : "size-4"} />
            }
            label={isBookmarked ? t("bookmarkRemove") : t("bookmark")}
            onClick={onBookmark}
            disabled={busy || !message}
            testid="message-action-bookmark"
          />
          {message?.role === "assistant" && ttsEnabled && (
            <Row
              icon={
                readAloudLoading ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : readAloudActive ? (
                  <SquareIcon className="size-4" />
                ) : (
                  <Volume2Icon className="size-4" />
                )
              }
              label={readAloudActive ? t("stopReading") : t("readAloud")}
              onClick={onReadAloud}
              disabled={busy || !text}
              testid="message-action-read-aloud"
            />
          )}
          {branchSessionId && (
            <Row
              icon={<GitBranchIcon className="size-4" />}
              label={t("branch")}
              onClick={onBranch}
              disabled={busy}
              testid="message-action-branch"
            />
          )}
          {message?.role === "assistant" && (
            // BranchNavigator renders null when the message has <2 regeneration
            // siblings; `has-[...]` keeps the labeled row hidden with it.
            <div
              className="hidden items-center justify-between px-3 py-2 has-[[data-testid=branch-navigator]]:flex"
              data-testid="message-action-branch-variants"
            >
              <span className="text-sm text-muted-foreground">{t("branchVariants")}</span>
              <BranchNavigator message={message} />
            </div>
          )}
          {onEditResend && (
            <Row
              icon={<PencilIcon className="size-4" />}
              label={t("edit")}
              onClick={() => setEditText(text)}
              disabled={busy || !text}
              testid="message-action-edit"
            />
          )}
          {onRegenerate && (
            <Row
              icon={<RefreshCcwIcon className="size-4" />}
              label={t("regenerate")}
              onClick={onRegenerateRow}
              disabled={busy}
              testid="message-action-regenerate"
            />
          )}
          {onDelete && (
            <Row
              icon={<Trash2Icon className="size-4 text-destructive" />}
              label={t("delete")}
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              testid="message-action-delete"
            />
          )}
          {message?.role === "assistant" && usage && (
            <div
              className="mt-1 border-t border-border px-3 pt-2 text-xs text-muted-foreground"
              data-testid="message-action-usage"
            >
              <UsageBreakdown usage={usage} />
            </div>
          )}
        </StaggeredRows>
        )}
      </DrawerContent>
    </Drawer>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onDeleteConfirmed()}
              data-testid="message-action-delete-confirm"
            >
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {branchTarget && (
        <BranchDialog
          sessionId={branchTarget.sessionId}
          messageId={branchTarget.messageId}
          open={branchTarget !== null}
          onOpenChange={(o) => {
            if (!o) setBranchTarget(null)
          }}
        />
      )}
    </>
  )
}

function StaggeredRows({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      className="flex flex-col gap-1 p-4 pb-8"
      initial={reduce ? false : "initial"}
      animate="animate"
      variants={STAGGER_CONTAINER}
    >
      {/* Each Row is wrapped in a motion span so it picks up STAGGER_CHILD
       *  without forcing Row itself to be a motion component (keeps the
       *  Button slot intact for shadcn focus + disabled handling). */}
      {Array.isArray(children)
        ? children.map((child, i) => (
            <motion.span key={i} variants={STAGGER_CHILD} className="contents">
              {child}
            </motion.span>
          ))
        : children}
    </motion.div>
  )
}

interface RowProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  testid: string
}

function Row({ icon, label, onClick, disabled, testid }: RowProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="touch-target h-auto w-full justify-start gap-3 px-3 py-2 text-left text-sm font-normal"
    >
      <span aria-hidden="true">{icon}</span>
      <span className="flex-1">{label}</span>
    </Button>
  )
}

/**
 * Concatenate every text/reasoning fragment in a UIMessage into plain
 * text. Skips tool blocks and binary parts since the user can't paste
 * those into a clipboard or another app meaningfully.
 */
export function extractPlainText(message: UIMessage): string {
  const out: string[] = []
  for (const part of message.parts ?? []) {
    const type = (part as { type?: string }).type
    if (type === "text" || type === "reasoning") {
      const text = (part as { text?: string }).text ?? ""
      if (text) out.push(text)
    }
  }
  return out.join("\n").trim()
}
