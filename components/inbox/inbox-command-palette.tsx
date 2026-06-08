"use client"

/**
 * Inbox ⌘K / Ctrl+K command palette.
 *
 * A single globally-mounted `CommandDialog` (cmdk) that lets the operator
 * jump to any platform-bound conversation without hunting through the list.
 * Live-queries every session with a `platformBinding`, ranked newest-first,
 * and filters by title / platform / conversationKey via cmdk's built-in
 * fuzzy matcher (the `value` prop). Selecting a row routes to
 * `/inbox/c/<conversationKey>`.
 *
 * Mounted once inside `<InboxShell />` so the shortcut works from any inbox
 * route. The key listener toggles open; Escape / outside-click close via the
 * underlying Dialog.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { PlatformBadge } from "./platform-badge"

export function InboxCommandPalette() {
  const t = useTranslations("inbox.commandPalette")
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // ⌘K (macOS) / Ctrl+K (Windows/Linux) toggles the palette from any inbox
  // route. We claim the shortcut globally while the inbox shell is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const sessions = useLiveQuery<ChatSession[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .sessions.filter((s) => s.platformBinding != null)
            .toArray()
            .then((rows) => rows.sort((a, b) => b.updatedAt - a.updatedAt)),
    []
  )

  const handleSelect = (conversationKey: string) => {
    setOpen(false)
    router.push(`/inbox/c?key=${encodeURIComponent(conversationKey)}`)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("placeholder")} data-testid="inbox-command-input" />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>
        <CommandGroup heading={t("conversations")}>
          {(sessions ?? []).map((session) => {
            const ck = session.platformBinding!.conversationKey
            const platform = session.platformBinding!.platform as PlatformKind
            const title = session.title || ck
            return (
              <CommandItem
                key={session.id}
                value={`${title} ${platform} ${ck}`}
                onSelect={() => handleSelect(ck)}
                data-testid={`inbox-command-item-${ck}`}
              >
                <PlatformBadge platform={platform} iconOnly className="shrink-0" />
                <span className="truncate">{title}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{platform}</span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
