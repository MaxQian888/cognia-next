"use client"

import { useTranslations } from "next-intl"
import { TriangleAlertIcon } from "lucide-react"
import type { StoredMessage } from "@cognia/agent-config-types"

import { refusedHostMessageOf } from "@/lib/chat/refused-host-message"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { diagnoseCommandError } from "@/lib/diagnostics/adapters/from-command-error"

/** Local refused intents stay beside, and outside, the Host's transcript. */
export function RefusedHostMessages({ messages }: { messages: StoredMessage[] }) {
  const t = useTranslations("chat.refusedHostMessages")
  const tDiagnostics = useTranslations("diagnostics")
  if (!messages?.length) return null

  return (
    <div className="max-h-64 shrink-0 space-y-3 overflow-y-auto px-4 py-3">
      {messages.map((message) => {
        const refusal = refusedHostMessageOf(message)!
        const diagnostic = diagnoseCommandError({
          code: refusal.code,
          message: refusal.code,
          retryable: false,
          structured: true,
        })
        const labelKey = `code.${diagnostic.code}.label`
        const reason = tDiagnostics.has(labelKey) ? tDiagnostics(labelKey) : t("unknownReason")
        return (
          <article
            key={message.id}
            aria-label={t("notSent")}
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          >
            <p className="flex items-center gap-1.5 text-xs text-destructive" role="status">
              <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
              {t("failure", { reason })}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm select-text">
              {extractPlainText(stripPromptPreambleFromParts(message.parts))}
            </p>
            {refusal.attachments.length > 0 && (
              <ul aria-label={t("attachments")} className="mt-2 text-xs text-muted-foreground">
                {refusal.attachments.map((attachment, index) => (
                  <li key={index}>{attachment.name}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t("keptLocally")}</p>
          </article>
        )
      })}
    </div>
  )
}
