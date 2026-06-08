"use client"

// Renders the divider the SDK emits when it compacts the conversation context
// (manual `/compact` or the automatic threshold). The adapter
// (`lib/claude/adapter.ts:appendCompactBoundary`) projects the SDK
// `compact_boundary` system message into a `system`-role UIMessage carrying a
// single `compact-boundary` part; the message list swaps this marker in for
// the normal `MessageRenderer` so it shows no avatar / actions / usage chrome.

import { useTranslations } from "next-intl"
import { ScissorsIcon } from "lucide-react"
import type { UIMessage } from "ai"

const compactNum = new Intl.NumberFormat("en-US", { notation: "compact" })

export interface CompactBoundaryPartData {
  type: "compact-boundary"
  trigger?: string
  preTokens?: number
  postTokens?: number
}

/** True when a message is the synthetic compact-boundary marker. */
export function isCompactBoundaryMessage(message: UIMessage): boolean {
  return (
    message.role === "system" &&
    message.parts.length === 1 &&
    (message.parts[0] as { type?: string }).type === "compact-boundary"
  )
}

export function CompactBoundaryMarker({ message }: { message: UIMessage }) {
  const t = useTranslations("chat.compactBoundary")
  const part = message.parts[0] as unknown as CompactBoundaryPartData
  const detail =
    part.preTokens !== undefined && part.postTokens !== undefined
      ? t("detail", {
          from: compactNum.format(part.preTokens),
          to: compactNum.format(part.postTokens),
        })
      : part.trigger === "manual"
        ? t("manual")
        : t("auto")

  return (
    <div
      className="my-3 flex items-center gap-2 px-1 text-xs text-muted-foreground"
      data-testid="compact-boundary"
      role="separator"
      aria-label={t("label")}
    >
      <div className="h-px flex-1 bg-border" />
      <ScissorsIcon className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">{t("label")}</span>
      <span className="shrink-0 text-muted-foreground/70">· {detail}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
