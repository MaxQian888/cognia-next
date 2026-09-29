"use client"

/**
 * A native page dialog (`alert` / `confirm` / `prompt` / `beforeunload`)
 * raised in a local-runtime page (ADR-0201). The page is blocked until it is
 * answered, and the canvas cannot show the browser's own dialog chrome, so the
 * pane asks here and answers through `browser.dialog.handle`.
 */

import { useTranslations } from "next-intl"
import { useState } from "react"

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
import { Input } from "@/components/ui/input"
import type { LocalBrowserDialog as DialogState } from "@/hooks/browser/use-local-browser-session"

const TITLE_KEYS = {
  alert: "alert",
  confirm: "confirm",
  prompt: "prompt",
  beforeunload: "beforeunload",
} as const

export function LocalBrowserDialog({
  dialog,
  onAnswer,
}: {
  dialog: DialogState | null
  /** Resolve the page's dialog; `promptText` only for a prompt that was accepted. */
  onAnswer: (answer: { accept: boolean; promptText?: string }) => void
}) {
  const t = useTranslations("browserLocal.dialog")
  // Re-seeded per dialog by keying the body on it, not by an effect.
  return (
    <AlertDialog open={dialog !== null}>
      {dialog && (
        <DialogBody
          key={`${dialog.type}:${dialog.message}`}
          dialog={dialog}
          onAnswer={onAnswer}
          t={t}
        />
      )}
    </AlertDialog>
  )
}

function DialogBody({
  dialog,
  onAnswer,
  t,
}: {
  dialog: DialogState
  onAnswer: (answer: { accept: boolean; promptText?: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [text, setText] = useState(dialog.defaultValue ?? "")
  const titleKey = TITLE_KEYS[dialog.type as keyof typeof TITLE_KEYS] ?? "alert"
  const isPrompt = dialog.type === "prompt"
  const canDismiss = dialog.type !== "alert"
  return (
    <AlertDialogContent data-testid="local-browser-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{t(titleKey)}</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-wrap break-words">
          {dialog.message}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {isPrompt && (
        <Input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={t("promptLabel")}
        />
      )}
      <AlertDialogFooter>
        {canDismiss && (
          <AlertDialogCancel onClick={() => onAnswer({ accept: false })}>
            {t("dismiss")}
          </AlertDialogCancel>
        )}
        <AlertDialogAction
          onClick={() => onAnswer(isPrompt ? { accept: true, promptText: text } : { accept: true })}
        >
          {t("accept")}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}
