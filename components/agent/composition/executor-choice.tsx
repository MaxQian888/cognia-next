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
 * it without touching the row — that rides the composition axis and resets
 * itself after the send.
 */

import { useTranslations } from "next-intl"
import { UsersIcon, UserIcon } from "lucide-react"

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { ChatExecutor } from "./use-chat-executor"

/** Sentinel for "no Squad" — a radio group cannot carry `null` as a value. */
const SINGLE_AGENT = "__single_agent__"

export interface ExecutorChoiceProps {
  executor: ChatExecutor
  disabled?: boolean
}

function useExecutorLabels() {
  const t = useTranslations("agentComposition.executor")
  return t
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
            <UsersIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate">{squad.name}</span>
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
  const rowClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50"

  return (
    <div className="mb-3 space-y-0.5" data-testid="executor-choice-list">
      <p className="px-2 text-xs font-medium text-muted-foreground">{t("label")}</p>
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
      {executor.squads.map((squad) => (
        <button
          key={squad.id}
          type="button"
          disabled={disabled || !executor.bindable}
          aria-pressed={executor.squadId === squad.id}
          onClick={() => void executor.select(squad.id)}
          data-testid="executor-squad"
          className={cn(rowClass, executor.squadId === squad.id && "bg-accent font-medium")}
        >
          <UsersIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{squad.name}</span>
        </button>
      ))}
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
