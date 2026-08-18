"use client"

/**
 * Pick one platform-bound (IM) conversation.
 *
 * A `CommandDialog` over every session that carries a `platformBinding`, newest
 * first, filtered by title / conversation key / platform as the user types.
 * The chat message row's "send to IM…" action opens it to choose where a
 * message goes; it decides nothing about the send itself — the caller gets the
 * chosen session and does the rest.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { getDb } from "@/lib/db/schema"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { PlatformBadge } from "./platform-badge"

export type PlatformBoundSession = ChatSession & {
  platformBinding: NonNullable<ChatSession["platformBinding"]>
}

export function isPlatformBoundSession(session: ChatSession): session is PlatformBoundSession {
  return session.platformBinding != null
}

/** Newest-first list of platform-bound sessions, from Dexie. */
export async function listPlatformBoundSessions(): Promise<PlatformBoundSession[]> {
  const rows = await getDb()
    .sessions.filter((s) => s.platformBinding != null)
    .toArray()
  return rows.filter(isPlatformBoundSession).sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface ConversationPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the chosen conversation; the dialog closes itself first. */
  onSelect: (session: PlatformBoundSession) => void
  /** Sessions to offer. Defaults to every platform-bound session in Dexie. */
  sessions?: readonly PlatformBoundSession[]
  /** Leave this session out (the one the message already lives in). */
  excludeSessionId?: string
}

export function ConversationPickerDialog({
  open,
  onOpenChange,
  onSelect,
  sessions: sessionsProp,
  excludeSessionId,
}: ConversationPickerDialogProps) {
  const t = useTranslations("chat.message.imPicker")
  const live = useLiveQuery<PlatformBoundSession[] | undefined, undefined>(
    () => {
      if (sessionsProp || !open || typeof window === "undefined") {
        return Promise.resolve(undefined)
      }
      return listPlatformBoundSessions()
    },
    [open, sessionsProp !== undefined],
    undefined
  )
  const sessions = useMemo(
    () => (sessionsProp ?? live ?? []).filter((s) => s.id !== excludeSessionId),
    [sessionsProp, live, excludeSessionId]
  )
  const loading = !sessionsProp && live === undefined

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("search")} data-testid="conversation-picker-input" />
      <CommandList>
        {!loading && (
          <CommandEmpty>
            {sessions.length === 0 ? t("noPlatformSessions") : t("empty")}
          </CommandEmpty>
        )}
        {sessions.length > 0 && (
          <CommandGroup heading={t("title")}>
            {sessions.map((session) => {
              const { conversationKey, platform } = session.platformBinding
              const title = session.title?.trim() || conversationKey
              return (
                <CommandItem
                  key={session.id}
                  value={`${title} ${conversationKey} ${platform}`}
                  onSelect={() => {
                    onOpenChange(false)
                    onSelect(session)
                  }}
                  data-testid={`conversation-picker-item-${session.id}`}
                >
                  <PlatformBadge platform={platform as PlatformKind} iconOnly />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  <span className="ml-auto max-w-[45%] truncate font-mono text-[11px] text-muted-foreground">
                    {conversationKey}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
