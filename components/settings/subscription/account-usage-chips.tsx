"use client"

// ADR-0028 §UI surfaces — "in use by X" chips for the subscription
// account list. Tells the user at a glance which characters and active
// sessions are pinned to a specific account.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Badge } from "@/components/ui/badge"
import { listCharacters } from "@/lib/db/characters"
import { listSessions } from "@/lib/db/sessions"

/** One account's references, pre-grouped by {@link useAccountUsageIndex}. */
export interface AccountUsage {
  characters: Array<{ id: string; name: string }>
  sessions: Array<{ id: string; title: string }>
}

/**
 * Chips shown per row before the rest collapse into a "+N more" badge.
 *
 * An account pinned to dozens of sessions used to render one badge each,
 * blowing the row's width out inside an already narrow settings pane.
 */
const MAX_VISIBLE_CHIPS = 3

/**
 * Read the character/session → account mapping ONCE for a whole list.
 *
 * Each row used to run its own `useLiveQuery(listCharacters)` +
 * `useLiveQuery(listSessions)`, so rendering N accounts meant 2N full-table
 * scans of two tables whose contents are identical for every row. Hoisting the
 * query to the list makes it 2 scans, regardless of how many accounts exist.
 */
export function useAccountUsageIndex(): Map<string, AccountUsage> {
  const characters = useLiveQuery(() => listCharacters(), [])
  const sessions = useLiveQuery(() => listSessions(), [])

  return useMemo(() => {
    const index = new Map<string, AccountUsage>()
    const entry = (accountId: string): AccountUsage => {
      let e = index.get(accountId)
      if (!e) {
        e = { characters: [], sessions: [] }
        index.set(accountId, e)
      }
      return e
    }

    for (const character of characters ?? []) {
      if (character.accountIdOverride) {
        entry(character.accountIdOverride).characters.push({
          id: character.id,
          name: character.name,
        })
      }
    }
    for (const session of sessions ?? []) {
      if (session.accountId) {
        entry(session.accountId).sessions.push({
          id: session.id,
          title: session.title || session.id.slice(0, 8),
        })
      }
    }
    return index
  }, [characters, sessions])
}

export interface AccountUsageChipsProps {
  accountId: string
  /** This account's slice of {@link useAccountUsageIndex}. */
  usage: AccountUsage | undefined
}

export function AccountUsageChips({ accountId, usage }: AccountUsageChipsProps) {
  const t = useTranslations("subscription.common.accountList")

  const characterRefs = usage?.characters ?? []
  const sessionRefs = usage?.sessions ?? []
  const total = characterRefs.length + sessionRefs.length
  if (total === 0) return null

  const visibleCharacters = characterRefs.slice(0, MAX_VISIBLE_CHIPS)
  const remainingSlots = MAX_VISIBLE_CHIPS - visibleCharacters.length
  const visibleSessions = remainingSlots > 0 ? sessionRefs.slice(0, remainingSlots) : []
  const hidden = total - visibleCharacters.length - visibleSessions.length

  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid={`account-usage-chips-${accountId}`}>
      {visibleCharacters.map((char) => (
        <Badge
          key={`char-${char.id}`}
          variant="secondary"
          className="max-w-[12rem] truncate text-[10px]"
          data-testid={`account-usage-character-${char.id}`}
        >
          {t("inUseByCharacter", { name: char.name })}
        </Badge>
      ))}
      {visibleSessions.map((session) => (
        <Badge
          key={`session-${session.id}`}
          variant="outline"
          className="max-w-[12rem] truncate text-[10px]"
          data-testid={`account-usage-session-${session.id}`}
        >
          {t("inUseBySession", { name: session.title })}
        </Badge>
      ))}
      {hidden > 0 && (
        <Badge
          variant="outline"
          className="text-[10px]"
          data-testid={`account-usage-more-${accountId}`}
        >
          {t("inUseMore", { count: hidden })}
        </Badge>
      )}
    </div>
  )
}
