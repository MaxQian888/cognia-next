"use client"

import { useCallback, useEffect, useRef } from "react"
import { MessageSquareIcon } from "lucide-react"
import { motion } from "motion/react"
import { useLocale, useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { buildMultiChatSharePayload } from "@/lib/share/chat-export"
import type { SharePayload } from "@/lib/share/types"
import { useReducedMotionVariants } from "@/lib/ui/motion"

interface Props {
  sessions: ChatSession[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SUMMARY_VARIANTS = {
  initial: { opacity: 0, y: 6, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.99 },
}

/**
 * Chat-owned wrapper around the generic encrypted-link lifecycle.
 *
 * `sessions` is a click-time snapshot from the channel-list selection. The
 * payload promise is cached for the lifetime of that snapshot so Preview and
 * Create publish the exact same transcript without repeating Dexie reads and
 * HTML rendering.
 */
export function MultiConversationShareDialog({ sessions, open, onOpenChange }: Props) {
  const t = useTranslations("share.multiConversation")
  const locale = useLocale()
  const payloadPromiseRef = useRef<Promise<SharePayload> | null>(null)
  const summaryVariants = useReducedMotionVariants(SUMMARY_VARIANTS)

  useEffect(() => {
    payloadPromiseRef.current = null
  }, [open, sessions])

  const buildPayload = useCallback(() => {
    if (payloadPromiseRef.current) return payloadPromiseRef.current

    const promise = buildMultiChatSharePayload({
      sessions,
      title: t("title", { count: sessions.length }),
      lang: locale,
      copy: {
        count: t("count", { count: sessions.length }),
        navigationLabel: t("navigationLabel"),
        previous: t("previous"),
        next: t("next"),
        frameTitle: t("frameTitle"),
      },
    })
    payloadPromiseRef.current = promise
    void promise.catch(() => {
      if (payloadPromiseRef.current === promise) payloadPromiseRef.current = null
    })
    return promise
  }, [locale, sessions, t])

  const summary = (
    <motion.section
      aria-label={t("summary", { count: sessions.length })}
      className="overflow-hidden rounded-lg border bg-muted/30"
      variants={summaryVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
    >
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        {t("summary", { count: sessions.length })}
      </div>
      <ScrollArea className="max-h-36">
        <ul className="space-y-0.5 p-1.5">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate" title={session.title}>
                {session.title || t("untitled")}
              </span>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </motion.section>
  )

  return (
    <ShareLinkDialog
      open={open}
      onOpenChange={onOpenChange}
      buildPayload={buildPayload}
      artifactSummary={summary}
    />
  )
}
