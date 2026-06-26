"use client"

// Surfaces a toast when the conversation is compacted, gated on the
// `showCompressionNotification` setting (CompressionSettings). The compaction
// boundary already arrives as a `compact-boundary` UIMessage part (projected by
// `lib/claude/adapter.ts:appendCompactBoundary`); this hook watches the message
// list for a NEWLY-appeared boundary and notifies once per boundary.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { UIMessage } from "ai"

import { useSettingsStore } from "@/stores/settings"
import {
  isCompactBoundaryMessage,
  type CompactBoundaryPartData,
} from "@/components/chat/message-parts/compact-boundary-part"

const compactNum = new Intl.NumberFormat("en-US", { notation: "compact" })

/**
 * Toast on each new compaction boundary. Existing boundaries present on the
 * first render (loaded history) are primed as "already seen" so re-opening a
 * thread never replays stale toasts.
 */
export function useCompactionToast(messages: UIMessage[]): void {
  const t = useTranslations("chat.compaction")
  const show = useSettingsStore((s) => s.settings?.compaction?.showCompressionNotification ?? true)
  const seen = useRef<Set<string>>(new Set())
  const primed = useRef(false)

  useEffect(() => {
    const boundaries = messages.filter(isCompactBoundaryMessage)

    // First pass: prime existing boundaries without toasting.
    if (!primed.current) {
      for (const m of boundaries) seen.current.add(m.id)
      primed.current = true
      return
    }

    for (const m of boundaries) {
      if (seen.current.has(m.id)) continue
      seen.current.add(m.id)
      if (!show) continue

      const part = m.parts[0] as unknown as CompactBoundaryPartData
      const { preTokens, postTokens } = part
      const opts =
        typeof preTokens === "number" && typeof postTokens === "number"
          ? {
              description: t("notificationDetail", {
                from: compactNum.format(preTokens),
                to: compactNum.format(postTokens),
              }),
            }
          : undefined
      toast(t("notification"), opts)
    }
  }, [messages, show, t])
}
