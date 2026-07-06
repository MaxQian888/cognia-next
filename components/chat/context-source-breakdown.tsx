"use client"

/**
 * Estimate-path companion to `SdkBreakdown`: when the live SDK context usage
 * isn't available, break the *visible transcript* down by injection source
 * (user messages, mentioned files, tool outputs, thinking, task coordination).
 * Reuses the shared `UsageRow` row + the toolbar `breakdown*` labels; hides
 * zero-token categories, matching `SdkBreakdown`.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { UIMessage } from "ai"

import {
  buildContextSourceBreakdown,
  type ContextSourceId,
} from "@/lib/analysis/context-source-breakdown"
import { UsageRow } from "@/components/chat/context-usage-indicator"
import type { UsageDisplayMode } from "@/types/appearance"

const compact = new Intl.NumberFormat("en-US", { notation: "compact" })

const LABEL_KEY: Record<ContextSourceId, string> = {
  userMessages: "breakdownUserMessages",
  mentionedFiles: "breakdownMentionedFiles",
  toolOutputs: "breakdownToolOutputs",
  thinking: "breakdownThinking",
  taskCoordination: "breakdownTaskCoordination",
}

export function ContextSourceBreakdown({
  messages,
  mode,
}: {
  messages: UIMessage[]
  mode?: UsageDisplayMode
}) {
  const t = useTranslations("chat.composer.toolbar")
  const { rows } = useMemo(() => buildContextSourceBreakdown(messages), [messages])
  if (mode === "simplified") return null
  if (rows.length === 0) return null
  return (
    <div className="mt-1.5 space-y-1.5 border-t pt-1.5" data-testid="context-source-breakdown">
      <p className="text-[10px] uppercase text-muted-foreground">{t("breakdownSourceTitle")}</p>
      {rows.map((r) => (
        <UsageRow
          key={r.id}
          label={t(LABEL_KEY[r.id])}
          slot={<span>{compact.format(r.tokens)}</span>}
        />
      ))}
    </div>
  )
}
