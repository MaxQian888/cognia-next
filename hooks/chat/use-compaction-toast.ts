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
  const cursor = useRef<{
    length: number
    firstId?: string
    lastId?: string
    penultimateId?: string
  } | null>(null)

  useEffect(() => {
    const nextCursor = {
      length: messages.length,
      firstId: messages[0]?.id,
      lastId: messages.at(-1)?.id,
      penultimateId: messages.at(-2)?.id,
    }
    const previous = cursor.current
    cursor.current = nextCursor

    // First pass: prime existing boundaries without toasting.
    if (!primed.current) {
      for (const message of messages) {
        if (isCompactBoundaryMessage(message)) seen.current.add(message.id)
      }
      primed.current = true
      return
    }

    // MessageList can survive a session switch. Prime the newly loaded history
    // instead of replaying old compaction notifications from another session.
    if (
      previous &&
      previous.length > 0 &&
      messages.length > 0 &&
      previous.firstId !== nextCursor.firstId
    ) {
      seen.current.clear()
      for (const message of messages) {
        if (isCompactBoundaryMessage(message)) seen.current.add(message.id)
      }
      return
    }

    let scanFrom = 0
    if (
      previous &&
      previous.length === messages.length &&
      previous.firstId === nextCursor.firstId &&
      previous.lastId === nextCursor.lastId &&
      previous.penultimateId === nextCursor.penultimateId
    ) {
      // The common streaming frame: only the trailing assistant object grew.
      scanFrom = Math.max(0, messages.length - 1)
    } else if (
      previous &&
      messages.length > previous.length &&
      previous.firstId === nextCursor.firstId &&
      messages[previous.length - 1]?.id === previous.lastId
    ) {
      // Append-only message boundary: only the new suffix can contain a new
      // compaction marker.
      scanFrom = previous.length
    }

    for (let index = scanFrom; index < messages.length; index++) {
      const m = messages[index]
      if (!m || !isCompactBoundaryMessage(m)) continue
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
