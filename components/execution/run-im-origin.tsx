"use client"

/**
 * "Where did this run come from" row, for a run that was started from a chat.
 *
 * A conversation can hand work to a team or a workflow (`delegate`), and the
 * run detaches: it reports progress back into the thread and settles on its
 * own. From the desktop side that run was anonymous. `ExecutionRunBinding`
 * has carried `adapterId` and `conversationKey` since ADR-0089, so the link
 * existed the whole time and nothing rendered it, which left the operator with
 * a background run and no way to see the conversation that asked for it.
 *
 * Renders nothing for a run with no binding, which is every run started on the
 * desktop. Absence here means "not from a chat", not "failed to load".
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import Link from "next/link"

import { PlatformBadge } from "@/components/inbox/platform-badge"
import { getDb } from "@/lib/db/schema"
import { listExecutionRunBindings } from "@/lib/db/execution-runs"
import { parseConversationKey } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"

export interface RunImOriginProps {
  /** The run to look up. `undefined` while the caller's row is still loading. */
  runId: string | undefined
}

/** The resolved origin, or `null` when this run did not come from a chat. */
export function useRunImOrigin(runId: string | undefined) {
  return (
    useLiveQuery(async () => {
      if (typeof window === "undefined" || !runId) return null
      const bindings = await listExecutionRunBindings(runId).catch(() => [])
      // A run can hold several bindings when it reports into more than one
      // chat. The first with a usable key is the one that started it.
      for (const binding of bindings) {
        if (!binding.conversationKey) continue
        try {
          const { platform } = parseConversationKey(binding.conversationKey)
          // Platform IDs are not transcript row IDs. Scope the lookup to the
          // same session the Inbox route opens, since platform IDs can collide
          // across adapters and conversations.
          let sourceMessageId: string | undefined
          if (binding.sourceMessageId) {
            const db = getDb()
            const session = await db.sessions
              .filter((row) => row.platformBinding?.conversationKey === binding.conversationKey)
              .first()
            if (session) {
              const message = await db.messages
                .where("platformMessageId")
                .equals(binding.sourceMessageId)
                .filter((row) => row.sessionId === session.id)
                .first()
              sourceMessageId = message?.id
            }
          }
          return {
            conversationKey: binding.conversationKey,
            platform: platform as PlatformKind,
            // The message that started the run, when the binding recorded one.
            // Without it the link lands at the bottom of a thread that may be
            // hundreds of messages past the request being asked about.
            sourceMessageId,
          }
        } catch {
          // An unparseable key is a corrupt row, not a reason to claim the run
          // has no origin at all. Keep looking.
        }
      }
      return null
    }, [runId]) ?? null
  )
}

export function RunImOrigin({ runId }: RunImOriginProps) {
  const t = useTranslations("execution.imOrigin")
  const origin = useRunImOrigin(runId)
  if (!origin) return null

  const href =
    `/inbox/c?key=${encodeURIComponent(origin.conversationKey)}` +
    (origin.sourceMessageId ? `&messageId=${encodeURIComponent(origin.sourceMessageId)}` : "")

  return (
    <Link
      href={href}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs hover:underline"
      data-testid="run-im-origin"
      data-conversation-key={origin.conversationKey}
    >
      <PlatformBadge platform={origin.platform} iconOnly />
      <span className="truncate">{t("open")}</span>
    </Link>
  )
}
