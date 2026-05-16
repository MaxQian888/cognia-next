"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PinIcon, PinOffIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { updateSession } from "@/lib/db/sessions"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import type { Character, ChatSession } from "@/lib/claude/types"

import { SwipeRow } from "../interactions/swipe-row"
import { LongPress } from "../interactions/long-press"

export interface MobileChannelListProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewDirect: () => void
  onDelete: (id: string) => void | Promise<void>
}

interface ResolvedSession {
  session: ChatSession
  unread: number
  glyph: string
  color: string
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}d`
}

export function MobileChannelList({
  sessions,
  activeSessionId,
  onSelect,
  onNewDirect,
  onDelete,
}: MobileChannelListProps) {
  const t = useTranslations("mobile.home")
  const tShell = useTranslations("mobile.shell")
  const [query, setQuery] = useState("")

  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const c of characters ?? []) map.set(c.id, c)
    return map
  }, [characters])

  const sessionStates = useClientLiveQuery(() => listSessionStates(), [], [])
  const unreadById = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates])

  const resolved: ResolvedSession[] = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    return sessions
      .map((s): ResolvedSession => {
        const ch = s.characterId ? characterById.get(s.characterId) : undefined
        const subject = ch ?? { name: s.title }
        return {
          session: s,
          unread: unreadById.get(s.id) ?? 0,
          glyph: avatarGlyph(subject),
          color: avatarColor(subject),
        }
      })
      .filter((r) =>
        trimmed.length === 0 ? true : r.session.title.toLowerCase().includes(trimmed)
      )
  }, [sessions, characterById, unreadById, query])

  const pinned = useMemo(() => resolved.filter((r) => r.session.pinned), [resolved])
  const recent = useMemo(
    () =>
      resolved
        .filter((r) => !r.session.pinned)
        .sort((a, b) => b.session.updatedAt - a.session.updatedAt),
    [resolved]
  )

  const togglePin = async (session: ChatSession) => {
    await updateSession(session.id, { pinned: !session.pinned }).catch(() => undefined)
  }

  return (
    <div className="flex h-full flex-col" data-testid="mobile-channel-list">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden="true"
            className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            aria-label={t("searchAria")}
            data-testid="mobile-channel-search"
            className="h-9 pl-7 pr-8 text-sm"
          />
          {query.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={tShell("clearSearch")}
              data-testid="mobile-channel-search-clear"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onNewDirect}
          aria-label={tShell("newChat")}
          data-testid="mobile-channel-new"
        >
          <PlusIcon />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {resolved.length === 0 ? (
          <p
            className="px-4 py-8 text-center text-xs text-muted-foreground"
            data-testid="mobile-channel-empty"
          >
            {query.trim().length > 0 ? t("emptyFiltered", { query }) : t("emptyChats")}
          </p>
        ) : null}

        {pinned.length > 0 ? (
          <Section title={t("pinned")} testId="mobile-channel-pinned">
            {pinned.map((r) => (
              <ChannelRow
                key={r.session.id}
                resolved={r}
                active={r.session.id === activeSessionId}
                onSelect={() => onSelect(r.session.id)}
                onTogglePin={() => void togglePin(r.session)}
                onDelete={() => void onDelete(r.session.id)}
                pinLabel={t("swipeUnpin")}
                deleteLabel={t("swipeDelete")}
                unreadLabel={t("unreadCount", { count: r.unread })}
              />
            ))}
          </Section>
        ) : null}

        {recent.length > 0 ? (
          <Section title={t("recent")} testId="mobile-channel-recent">
            {recent.map((r) => (
              <ChannelRow
                key={r.session.id}
                resolved={r}
                active={r.session.id === activeSessionId}
                onSelect={() => onSelect(r.session.id)}
                onTogglePin={() => void togglePin(r.session)}
                onDelete={() => void onDelete(r.session.id)}
                pinLabel={t("swipePin")}
                deleteLabel={t("swipeDelete")}
                unreadLabel={t("unreadCount", { count: r.unread })}
              />
            ))}
          </Section>
        ) : null}
      </div>
    </div>
  )
}

function Section({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <section data-testid={testId}>
      <h2 className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <motion.ul
        className="flex flex-col"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {children}
      </motion.ul>
    </section>
  )
}

function ChannelRow({
  resolved,
  active,
  onSelect,
  onTogglePin,
  onDelete,
  pinLabel,
  deleteLabel,
  unreadLabel,
}: {
  resolved: ResolvedSession
  active: boolean
  onSelect: () => void
  onTogglePin: () => void
  onDelete: () => void
  pinLabel: string
  deleteLabel: string
  unreadLabel: string
}) {
  const { session, unread, glyph, color } = resolved
  return (
    <motion.li variants={STAGGER_CHILD}>
      <SwipeRow
        rightActions={[
          {
            id: "pin",
            label: pinLabel,
            icon: session.pinned ? (
              <PinOffIcon className="size-3.5" />
            ) : (
              <PinIcon className="size-3.5" />
            ),
            onSelect: onTogglePin,
          },
          {
            id: "delete",
            label: deleteLabel,
            icon: <Trash2Icon className="size-3.5" />,
            destructive: true,
            onSelect: onDelete,
          },
        ]}
      >
        <LongPress onLongPress={onTogglePin}>
          <Button
            type="button"
            variant="ghost"
            onClick={onSelect}
            data-testid={`mobile-channel-row-${session.id}`}
            data-active={active ? "true" : "false"}
            className={cn(
              "h-auto w-full justify-start gap-3 rounded-none px-3 py-2 text-left font-normal",
              active && "bg-muted/60"
            )}
          >
            <span className="relative shrink-0">
              <Avatar className="size-9">
                <AvatarFallback
                  style={{ backgroundColor: color }}
                  className="text-xs"
                  aria-hidden={glyph.length === 1 ? "true" : undefined}
                >
                  {glyph}
                </AvatarFallback>
              </Avatar>
              {unread > 0 ? (
                <span
                  data-testid={`mobile-channel-unread-${session.id}`}
                  aria-label={unreadLabel}
                  className="absolute -right-0.5 -top-0.5 inline-flex size-2 rounded-full bg-destructive"
                />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1">
                <span className="truncate text-sm font-medium">{session.title}</span>
                {session.pinned ? (
                  <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : null}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {relativeTime(session.updatedAt)}
              </span>
            </span>
          </Button>
        </LongPress>
      </SwipeRow>
    </motion.li>
  )
}
