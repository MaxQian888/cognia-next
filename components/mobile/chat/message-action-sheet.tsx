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
import { CopyIcon, Share2Icon } from "lucide-react"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { share } from "@/lib/capacitor/share"

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

  const text = message ? extractPlainText(message) : ""

  const onCopy = async () => {
    if (!text) return
    setBusy(true)
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("copySuccess"))
      onOpenChange(false)
    } catch (err) {
      toast.error(t("copyFailed", { message: err instanceof Error ? err.message : String(err) }))
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
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="message-action-sheet">
        <DrawerHeader>
          <DrawerTitle>{t("title")}</DrawerTitle>
          <DrawerDescription>{t("description")}</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-1 p-4 pb-8">
          <Row
            icon={<CopyIcon className="size-4" />}
            label={t("copy")}
            onClick={onCopy}
            disabled={busy || !text}
            testid="message-action-copy"
          />
          <Row
            icon={<Share2Icon className="size-4" />}
            label={t("share")}
            onClick={onShare}
            disabled={busy || !text}
            testid="message-action-share"
          />
        </div>
      </DrawerContent>
    </Drawer>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="touch-target flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent active:bg-accent disabled:opacity-50"
    >
      <span aria-hidden="true">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
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
