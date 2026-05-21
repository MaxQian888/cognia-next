"use client"

// ADR-0028 §UI surfaces — "in use by X" chips for the subscription
// account list. Tells the user at a glance which characters and active
// sessions are pinned to a specific account.

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Badge } from "@/components/ui/badge"
import { listCharacters } from "@/lib/db/characters"
import { listSessions } from "@/lib/db/sessions"

export interface AccountUsageChipsProps {
  accountId: string
}

export function AccountUsageChips({ accountId }: AccountUsageChipsProps) {
  const t = useTranslations("subscription.common.accountList")
  const characters = useLiveQuery(() => listCharacters(), [])
  const sessions = useLiveQuery(() => listSessions(), [])

  const characterRefs = characters?.filter((c) => c.accountIdOverride === accountId) ?? []
  const sessionRefs = sessions?.filter((s) => s.accountId === accountId) ?? []

  if (characterRefs.length === 0 && sessionRefs.length === 0) return null

  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid={`account-usage-chips-${accountId}`}>
      {characterRefs.map((char) => (
        <Badge
          key={`char-${char.id}`}
          variant="secondary"
          className="text-[10px]"
          data-testid={`account-usage-character-${char.id}`}
        >
          {t("inUseByCharacter", { name: char.name })}
        </Badge>
      ))}
      {sessionRefs.map((session) => (
        <Badge
          key={`session-${session.id}`}
          variant="outline"
          className="text-[10px]"
          data-testid={`account-usage-session-${session.id}`}
        >
          {t("inUseBySession", { name: session.title || session.id.slice(0, 8) })}
        </Badge>
      ))}
    </div>
  )
}
