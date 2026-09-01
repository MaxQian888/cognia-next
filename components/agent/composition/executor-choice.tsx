"use client"

/**
 * The executor section of the composition chip: who runs this conversation.
 *
 * One entry, not two. Before this, "which model" sat on the composer row and
 * "which team" was a page you had to leave the conversation to reach, so the
 * two answers to the same question lived in different places and neither
 * mentioned the other.
 *
 * Picking a Squad writes `ChatSession.squadId` (see `useChatExecutor`), which
 * is the conversation's default from then on. A single turn can still override
 * it without touching the row. That rides the composition axis and resets
 * itself after the send.
 *
 * A row says what the Squad IS and what it is DOING: portrait, roster size, and
 * a status dot that separates running from parked-on-a-question. It used to be
 * a lucide glyph and a name, which made the control where a conversation gets
 * bound the least informed surface in the app about the thing being bound. The
 * data is the same derivation `/squads` sorts its fleet by
 * (`lib/agent/squad-presence.ts`), so the two cannot disagree.
 *
 * The list form gains a filter once there are enough Squads to need one. The
 * MENU form does not, deliberately: it renders inside a Radix `DropdownMenu`,
 * whose typeahead owns every keystroke, so a text field there would swallow
 * characters and look broken. Below the threshold both forms are the same list.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon, UserIcon } from "lucide-react"

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { AgentTeamAvatar } from "@/components/agent/workspace/agent-team-avatar"
import { cn } from "@/lib/utils"
import type { ChatExecutor, ChatExecutorSquad } from "./use-chat-executor"

/** Sentinel for "no Squad". A radio group cannot carry `null` as a value. */
const SINGLE_AGENT = "__single_agent__"

/**
 * Below this many Squads the filter is clutter: the whole list is on screen and
 * a text field costs a row to save nothing.
 */
const FILTER_THRESHOLD = 6

export interface ExecutorChoiceProps {
  executor: ChatExecutor
  disabled?: boolean
}

function useExecutorLabels() {
  const t = useTranslations("agentComposition.executor")
  return t
}

/** Case-insensitive name match. The only text a row carries that is worth searching. */
function filterSquads(squads: readonly ChatExecutorSquad[], query: string) {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return squads
  return squads.filter((squad) => squad.name.toLowerCase().includes(trimmed))
}

/**
 * Running, parked, or neither.
 *
 * Three states and three treatments, because collapsing "executing" and
 * "waiting for you" into one dot is how a picker stops telling you which Squad
 * needs something. Pulsing is reserved for the live one so a static screenshot
 * still distinguishes them by colour.
 */
function SquadStatusDot({ squad }: { squad: ChatExecutorSquad }) {
  const t = useExecutorLabels()
  const label = squad.waiting ? t("statusWaiting") : squad.live ? t("statusLive") : t("statusIdle")
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      data-testid="executor-squad-status"
      data-state={squad.waiting ? "waiting" : squad.live ? "live" : "idle"}
      className={cn(
        "size-2 shrink-0 rounded-full",
        squad.waiting
          ? "bg-amber-500"
          : squad.live
            ? "animate-pulse bg-emerald-500"
            : "bg-muted-foreground/40"
      )}
    />
  )
}

/**
 * One Squad's identity and state, shared by both forms.
 *
 * A plain `span` layout rather than a `PickerRow`: this row lives inside a
 * `DropdownMenuRadioItem` in one form and a `button` in the other, neither of
 * which is a cmdk `CommandItem`, and the tick is drawn by the radio indicator
 * or the pressed state rather than by the row itself.
 */
function SquadRowBody({ squad, active }: { squad: ChatExecutorSquad; active: boolean }) {
  const t = useExecutorLabels()
  return (
    <>
      <AgentTeamAvatar
        subject={{ id: squad.id, name: squad.name, description: squad.description ?? "" }}
        className="size-5 rounded-full"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("truncate text-xs leading-none", active && "font-medium")}>
          {squad.name}
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground">
          {t("memberCount", { count: squad.memberCount })}
        </span>
      </span>
      <SquadStatusDot squad={squad} />
    </>
  )
}

/** Menu form, for the wide row's dropdown. */
export function ExecutorMenuSection({ executor, disabled }: ExecutorChoiceProps) {
  const t = useExecutorLabels()
  const value = executor.squadId ?? SINGLE_AGENT

  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">{t("label")}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value}
        onValueChange={(next) => {
          void executor.select(next === SINGLE_AGENT ? null : next)
        }}
      >
        <DropdownMenuRadioItem
          value={SINGLE_AGENT}
          disabled={disabled || !executor.bindable}
          className="gap-2 text-xs"
          data-testid="executor-single-agent"
        >
          <UserIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{t("singleAgent")}</span>
        </DropdownMenuRadioItem>
        {executor.squads.map((squad) => (
          <DropdownMenuRadioItem
            key={squad.id}
            value={squad.id}
            disabled={disabled || !executor.bindable}
            className="gap-2 text-xs"
            data-testid="executor-squad"
          >
            <SquadRowBody squad={squad} active={executor.squadId === squad.id} />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <ExecutorEmptyNote executor={executor} className="px-2 pb-1" />
      <DropdownMenuSeparator />
    </>
  )
}

/** Button-list form, for the narrow layout's popover (no menu context there). */
export function ExecutorChoiceList({ executor, disabled }: ExecutorChoiceProps) {
  const t = useExecutorLabels()
  const [query, setQuery] = useState("")
  const showFilter = executor.squads.length >= FILTER_THRESHOLD
  const visible = useMemo(
    () => (showFilter ? filterSquads(executor.squads, query) : executor.squads),
    [executor.squads, query, showFilter]
  )
  const rowClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50"

  return (
    <div className="mb-3 space-y-0.5" data-testid="executor-choice-list">
      <p className="px-2 text-xs font-medium text-muted-foreground">{t("label")}</p>
      {showFilter ? (
        <div className="relative px-2 pb-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            data-testid="executor-search"
            className="h-8 pl-7 text-xs"
          />
        </div>
      ) : null}
      <button
        type="button"
        disabled={disabled || !executor.bindable}
        aria-pressed={executor.squadId === null}
        onClick={() => void executor.select(null)}
        data-testid="executor-single-agent"
        className={cn(rowClass, executor.squadId === null && "bg-accent font-medium")}
      >
        <UserIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{t("singleAgent")}</span>
      </button>
      {visible.map((squad) => (
        <button
          key={squad.id}
          type="button"
          disabled={disabled || !executor.bindable}
          aria-pressed={executor.squadId === squad.id}
          onClick={() => void executor.select(squad.id)}
          data-testid="executor-squad"
          className={cn(rowClass, executor.squadId === squad.id && "bg-accent")}
        >
          <SquadRowBody squad={squad} active={executor.squadId === squad.id} />
        </button>
      ))}
      {/*
        A filter that matches nothing is its own state. Falling through to the
        "no Squads yet" note below would tell the user to go create one they
        already have.
      */}
      {showFilter && visible.length === 0 ? (
        <p className="px-2 py-2 text-center text-[11px] text-muted-foreground">{t("noMatches")}</p>
      ) : null}
      <ExecutorEmptyNote executor={executor} className="px-2 pt-1" />
    </div>
  )
}

/**
 * Says why the list is short, rather than showing an unexplained single row.
 * The two reasons are different and only one of them is the user's to fix.
 */
function ExecutorEmptyNote({
  executor,
  className,
}: {
  executor: ChatExecutor
  className?: string
}) {
  const t = useExecutorLabels()
  if (!executor.bindable) {
    return <p className={cn("text-[11px] text-muted-foreground", className)}>{t("needsSession")}</p>
  }
  if (executor.squads.length === 0) {
    return <p className={cn("text-[11px] text-muted-foreground", className)}>{t("noSquads")}</p>
  }
  return null
}
