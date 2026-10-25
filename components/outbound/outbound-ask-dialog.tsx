"use client"

/**
 * The host's outbound ask dialog (ADR-0239 phase 2b): what an agent is about
 * to send that a person at this computer must decide, one question at a time,
 * oldest first (`stores/outbound/outbound-ask-store.ts`).
 *
 * Three answers: allow once, allow for this request (offered only when the
 * site can be granted that long), refuse, which blocks the site for the rest
 * of the request. The dialog cannot be dismissed without an answer: the agent
 * waits on it, and an unanswered question is refused when it expires.
 *
 * Mounted once at the root (`components/runtime/app-runtime.tsx`), so a
 * question raised anywhere is seen wherever the person is; mounting it is
 * what lets `requestOutboundAsk` ask at all.
 */

import { useEffect } from "react"
import { useFormatter, useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useOutboundAskStore, type OutboundAskEntry } from "@/stores/outbound/outbound-ask-store"

const POSSIBLE_ACTIONS = ["click", "double_click", "drag", "select"] as const

function useQuestionText(entry: OutboundAskEntry): string {
  const t = useTranslations("outboundAsk")
  const site = entry.site ?? t("noSite")
  if (entry.basis === "request") {
    const what =
      entry.operation === "WS"
        ? t("requestSocket")
        : t("requestMethod", { method: entry.operation })
    return t("requestBody", { what, site })
  }
  const press = /^press:(.+)$/.exec(entry.operation)
  const action = press
    ? t("possibleActions.press", { key: press[1] })
    : (POSSIBLE_ACTIONS as readonly string[]).includes(entry.operation)
      ? t(`possibleActions.${entry.operation as (typeof POSSIBLE_ACTIONS)[number]}`)
      : entry.operation
  return t("possibleBody", { action, site })
}

function Question({ entry, waiting }: { entry: OutboundAskEntry; waiting: number }) {
  const t = useTranslations("outboundAsk")
  const format = useFormatter()
  const answer = useOutboundAskStore((s) => s.answer)
  const text = useQuestionText(entry)
  return (
    <AlertDialogContent data-testid="outbound-ask-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{t("title")}</AlertDialogTitle>
        <AlertDialogDescription>{text}</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{entry.asker === "external-bridge" ? t("askerBridge") : t("askerChat")}</p>
        <p>{entry.forRequestOffered ? t("fenceNote") : t("fenceNoteOnce")}</p>
        <p>{t("expires", { time: format.dateTime(entry.expiresAt, { timeStyle: "short" }) })}</p>
        {waiting > 0 ? (
          <p data-testid="outbound-ask-waiting">{t("pending", { count: waiting })}</p>
        ) : null}
      </div>
      <AlertDialogFooter>
        <Button variant="outline" onClick={() => answer(entry.id, "refuse")}>
          {t("refuse")}
        </Button>
        {entry.forRequestOffered ? (
          <Button variant="outline" onClick={() => answer(entry.id, "request")}>
            {t("allowRequest")}
          </Button>
        ) : null}
        <Button onClick={() => answer(entry.id, "once")}>{t("allowOnce")}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

export function OutboundAskDialog() {
  const entries = useOutboundAskStore((s) => s.entries)
  const mountHost = useOutboundAskStore((s) => s.mountHost)
  useEffect(() => mountHost(), [mountHost])
  const current = entries[0]
  return (
    // Closing without an answer is not offered: Escape and the overlay do nothing.
    <AlertDialog open={Boolean(current)} onOpenChange={() => undefined}>
      {current ? <Question key={current.id} entry={current} waiting={entries.length - 1} /> : null}
    </AlertDialog>
  )
}
