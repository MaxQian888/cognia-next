"use client"

/**
 * Mobile bottom sheet for per-message actions (Wave 1.7).
 *
 * Triggered by long-press on a message row in the mobile shell. Provides:
 *   - Copy plain text to clipboard
 *   - Share via the system share sheet (Capacitor Share / navigator.share)
 *
 * Quote and Delete intentionally left out of v1: composer wiring for a
 * "quote and reply" flow is part of a future wave, and a per-message
 * delete IPC is not yet exposed in `useChatStore`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, GitBranchIcon, QuoteIcon, Share2Icon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { share } from "@/lib/capacitor/share"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { BranchDialog } from "@/components/chat/branch-dialog"
import { COMPOSER_APPEND_EVENT } from "@/components/chat/composer"

export interface MessageActionSheetProps {
  message: UIMessage | null
  onOpenChange: (next: boolean) => void
}

export function MessageActionSheet({ message, onOpenChange }: MessageActionSheetProps) {
  const t = useTranslations("mobile.messageActions")
  const open = message !== null
  // `busy` is always reset in the action handlers' try/finally below;
  // no separate effect needed to clear it on close.
  const [busy, setBusy] = useState(false)
  const [branchTarget, setBranchTarget] = useState<{
    sessionId: string
    messageId: string
  } | null>(null)

  const text = message ? extractPlainText(message) : ""
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
      toast.success(t("copySuccess"))
      onOpenChange(false)
    } catch (err) {
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
    window.dispatchEvent(
      new CustomEvent(COMPOSER_APPEND_EVENT, { detail: { text: `${quoted}\n\n` } })
    )
    void selectionFeedback()
    onOpenChange(false)
  }

  const onShare = async () => {
    if (!text) return
    setBusy(true)
    try {
      const out = await share({ text, dialogTitle: t("shareDialogTitle") })
      if (out.kind === "shared") {
        onOpenChange(false)
      } else if (out.kind === "unsupported") {
        toast.error(t("shareUnsupported"))
      } else if (out.kind === "error") {
        toast.error(t("shareFailed", { message: out.message }))
      }
      // cancelled — silent.
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="message-action-sheet">
        <DrawerHeader>
          <DrawerTitle>{t("title")}</DrawerTitle>
          <DrawerDescription>{t("description")}</DrawerDescription>
        </DrawerHeader>
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
          {branchSessionId && (
            <Row
              icon={<GitBranchIcon className="size-4" />}
              label={t("branch")}
              onClick={onBranch}
              disabled={busy}
              testid="message-action-branch"
            />
          )}
        </StaggeredRows>
      </DrawerContent>
    </Drawer>
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
