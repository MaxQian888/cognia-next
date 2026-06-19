"use client"

// Renders non-conversational "session notice" markers the adapter projects from
// SDK control events (`lib/claude/adapter.ts:appendSessionNotice`):
//   • permission-denied — a tool auto-denied without an interactive prompt
//     (classifier / dontAsk / deny rule); surfaced so the user sees WHY a tool
//     didn't run instead of only an is_error tool_result.
//   • rate-limit — the claude.ai subscription rate limit is restrictive
//     (`allowed_warning` / `rejected`).
// The message list swaps these markers in for the normal MessageRenderer so they
// show no avatar / actions / usage chrome.

import { useTranslations } from "next-intl"
import { ShieldAlertIcon, GaugeIcon } from "lucide-react"
import type { UIMessage } from "ai"

export interface SessionNoticePartData {
  type: "session-notice"
  variant: "permission-denied" | "rate-limit"
  toolName?: string
  reason?: string
  status?: string
  rateLimitType?: string
  resetsAt?: number
}

/** True when a message is a synthetic session-notice marker. */
export function isSessionNoticeMessage(message: UIMessage): boolean {
  return (
    message.role === "system" &&
    message.parts.length === 1 &&
    (message.parts[0] as { type?: string }).type === "session-notice"
  )
}

export function SessionNoticeMarker({ message }: { message: UIMessage }) {
  const t = useTranslations("chat.sessionNotice")
  const part = message.parts[0] as unknown as SessionNoticePartData

  const isDenied = part.variant === "permission-denied"
  const Icon = isDenied ? ShieldAlertIcon : GaugeIcon

  const label = isDenied ? t("permissionDenied.label") : t("rateLimit.label")
  const detail = isDenied
    ? part.toolName
      ? t("permissionDenied.detail", { tool: part.toolName })
      : (part.reason ?? "")
    : part.resetsAt
      ? t("rateLimit.detailWithReset", {
          status: t(`rateLimit.status.${part.status === "rejected" ? "rejected" : "warning"}`),
          time: new Date(part.resetsAt * 1000).toLocaleTimeString(),
        })
      : t(`rateLimit.status.${part.status === "rejected" ? "rejected" : "warning"}`)

  return (
    <div
      className="my-3 flex items-center gap-2 px-1 text-xs text-muted-foreground"
      data-testid={`session-notice-${part.variant}`}
      role="status"
      aria-label={label}
    >
      <div className="h-px flex-1 bg-border" />
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">{label}</span>
      {detail ? <span className="shrink-0 text-muted-foreground/70">· {detail}</span> : null}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
