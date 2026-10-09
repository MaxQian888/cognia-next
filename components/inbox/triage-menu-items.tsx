"use client"

/**
 * The Inbox triage option lists, written once and drawn in any menu.
 *
 * Status, snooze, assignee and labels are offered from five places: the
 * triage pane's chips, the list row's `⋯` menu, the keyboard's quick menus
 * (`s` / `i` / `l`), the bulk bar, and the phone's long-press sheet. Each used
 * to be — or would have become — a hand-copied list. These components render
 * the options through a `MenuKit` (`components/shared/menu-kit.tsx`), so a
 * Radix dropdown and the phone's sheet of touch rows offer the same items in
 * the same order with the same labels.
 *
 * They only render options and report the choice; the caller decides what a
 * choice writes (one conversation, or every checked one through
 * `lib/inbox/bulk-triage.ts`).
 */

import type { ComponentType, ReactNode } from "react"
import { useTranslations } from "next-intl"
import { BellRingIcon, MinusIcon } from "lucide-react"
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { DROPDOWN_MENU_KIT, type MenuKit } from "@/components/shared/menu-kit"
import { useConversationLabels } from "@/hooks/connectors/use-conversation-labels"
import { useCharacters } from "@/lib/data-hooks/context"
import type { ConversationAssignee, ConversationStatus } from "@/lib/db/conversation-overrides"
import type { LabelCheckState } from "@/lib/inbox/bulk-triage"
import { cn } from "@/lib/utils"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { SNOOZE_PRESETS, type SnoozePresetKey } from "@/lib/inbox/snooze-presets"

/** Status dot colours, shared by the chip, the row and the menus. */
export const STATUS_DOT: Record<ConversationStatus, string> = {
  open: "bg-emerald-500",
  pending: "bg-amber-500",
  snoozed: "bg-sky-500",
  resolved: "bg-muted-foreground",
}

/** Assignee kind colours, shared by the chip and the row's initials token. */
export const ASSIGNEE_KIND_DOT: Record<ConversationAssignee["kind"], string> = {
  human: "bg-indigo-500",
  character: "bg-violet-500",
  team: "bg-teal-500",
}

export interface TriageCheckboxItemProps {
  checked: boolean | "indeterminate"
  onCheckedChange?: (checked: boolean) => void
  onSelect?: (event: Event) => void
  children?: ReactNode
  className?: string
  "data-testid"?: string
}

/**
 * A `MenuKit` that can also draw a real checkbox item (`menuitemcheckbox`,
 * with `aria-checked="mixed"` for a label some of the checked rows carry). A
 * kit without one (the phone sheet) falls back to a plain item with a drawn
 * state, which is what a sheet of buttons can offer.
 */
export interface TriageMenuKit extends MenuKit {
  CheckboxItem?: ComponentType<TriageCheckboxItemProps>
  /**
   * A plain group heading. Falls back to `Label`, which is a heading in the
   * Radix menus but a warning note in the phone sheet — so the sheet kit
   * supplies its own (`TRIAGE_SHEET_KIT`).
   */
  Heading?: ComponentType<{ children?: ReactNode; className?: string }>
}

function DropdownTriageCheckboxItem({
  checked,
  className,
  children,
  ...rest
}: TriageCheckboxItemProps) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      // Radix draws its check for `indeterminate` too; hide it there and let
      // the minus glyph below say "some of them".
      className={cn("data-[state=indeterminate]:[&>span:first-child]:hidden", className)}
      {...rest}
    >
      {checked === "indeterminate" ? (
        <MinusIcon aria-hidden className="pointer-events-none absolute left-2 size-3.5" />
      ) : null}
      {children}
    </DropdownMenuCheckboxItem>
  )
}

export const TRIAGE_DROPDOWN_KIT: TriageMenuKit = {
  ...DROPDOWN_MENU_KIT,
  CheckboxItem: DropdownTriageCheckboxItem,
}

/** Human label for an assignee, matching the chip's wording. */
export function useAssigneeLabel(): (assignee: ConversationAssignee | null | undefined) => string {
  const t = useTranslations("inbox.assignee")
  return (assignee) =>
    !assignee
      ? t("unassigned")
      : assignee.kind === "human"
        ? t("me")
        : assignee.kind === "team"
          ? (assignee.label ?? t("team"))
          : (assignee.label ?? t("unknownCharacter"))
}

function sameAssignee(
  a: ConversationAssignee | null | undefined,
  b: ConversationAssignee | null | undefined
): boolean {
  if (!a || !b) return !a && !b
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null)
}

/** Lifecycle statuses. `includeSnooze` nests the snooze presets under "Snoozed". */
export function StatusMenuItems({
  kit,
  current,
  onSetStatus,
  includeSnooze = true,
  now,
}: {
  kit: MenuKit
  /** The status every target shares, if any (marked current). */
  current?: ConversationStatus
  onSetStatus: (status: ConversationStatus, snoozeUntil?: number) => void
  includeSnooze?: boolean
  /** Clock for snooze presets; read at choice time when absent. */
  now?: () => number
}) {
  const t = useTranslations("inbox.lifecycle")
  const K = kit
  const item = (status: Exclude<ConversationStatus, "snoozed">) => (
    <K.Item
      onSelect={() => onSetStatus(status)}
      aria-current={current === status ? "true" : undefined}
      data-testid={`triage-status-${status}`}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])} />
      {t(`status.${status}`)}
    </K.Item>
  )
  return (
    <>
      {item("open")}
      {item("pending")}
      {includeSnooze ? (
        <K.Sub>
          <K.SubTrigger data-testid="triage-status-snoozed">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT.snoozed)} />
            {t("status.snoozed")}
          </K.SubTrigger>
          <K.SubContent>
            <SnoozeMenuItems
              kit={kit}
              onSnooze={(_key, until) => onSetStatus("snoozed", until)}
              now={now}
            />
          </K.SubContent>
        </K.Sub>
      ) : null}
      <K.Separator />
      {item("resolved")}
    </>
  )
}

/** Snooze presets; "Wake now" when the targets are snoozed. */
export function SnoozeMenuItems({
  kit,
  snoozed = false,
  onSnooze,
  onWake,
  now = Date.now,
}: {
  kit: MenuKit
  /** Every target is snoozed: offer to wake them. */
  snoozed?: boolean
  onSnooze: (key: SnoozePresetKey, until: number) => void
  onWake?: () => void
  now?: () => number
}) {
  const t = useTranslations("inbox.lifecycle")
  const tMenu = useTranslations("inbox.triageMenu")
  const K = kit
  return (
    <>
      {SNOOZE_PRESETS.map((preset) => (
        <K.Item
          key={preset.key}
          onSelect={() => onSnooze(preset.key, now() + preset.ms)}
          data-testid={`triage-snooze-${preset.key}`}
        >
          {t(`snooze.${preset.key}`)}
        </K.Item>
      ))}
      {snoozed && onWake ? (
        <>
          <K.Separator />
          <K.Item onSelect={onWake} data-testid="triage-snooze-wake">
            <BellRingIcon className="size-4" aria-hidden />
            {tMenu("wakeNow")}
          </K.Item>
        </>
      ) : null}
    </>
  )
}

/** The assignable characters and teams, sorted the way the chip shows them. */
export function useAssigneeOptions() {
  const characters = useCharacters() ?? []
  const teamsById = useAgentTeamStore((s) => s.teams)
  const teams = Object.values(teamsById ?? {}).sort((a, b) => a.name.localeCompare(b.name))
  return { characters, teams }
}

/** Me, characters, teams, Unassign. */
export function AssigneeMenuItems({
  kit,
  current,
  onAssign,
  routingNote = false,
}: {
  kit: TriageMenuKit
  /** The assignee every target shares, if any (marked current). */
  current?: ConversationAssignee | null
  onAssign: (assignee: ConversationAssignee | null) => void
  /** Explain that assigning also re-routes replies (the chip's footnote). */
  routingNote?: boolean
}) {
  const t = useTranslations("inbox.assignee")
  const { characters, teams } = useAssigneeOptions()
  const K = kit
  const Heading = kit.Heading ?? kit.Label
  const isCurrent = (candidate: ConversationAssignee | null) =>
    current !== undefined && sameAssignee(current, candidate) ? ("true" as const) : undefined
  return (
    <>
      <K.Item
        onSelect={() => onAssign({ kind: "human" })}
        aria-current={isCurrent({ kind: "human" })}
        data-testid="assignee-me"
      >
        {t("me")}
      </K.Item>
      {characters.length > 0 ? (
        <>
          <K.Separator />
          <Heading className="text-xs text-muted-foreground">{t("character")}</Heading>
          {characters.map((character) => (
            <K.Item
              key={character.id}
              onSelect={() =>
                onAssign({ kind: "character", id: character.id, label: character.name })
              }
              aria-current={isCurrent({ kind: "character", id: character.id })}
              data-testid={`assignee-character-${character.id}`}
            >
              {character.name}
            </K.Item>
          ))}
        </>
      ) : null}
      {teams.length > 0 ? (
        <>
          <K.Separator />
          <Heading className="text-xs text-muted-foreground">{t("team")}</Heading>
          {teams.map((team) => (
            <K.Item
              key={team.id}
              onSelect={() => onAssign({ kind: "team", id: team.id, label: team.name })}
              aria-current={isCurrent({ kind: "team", id: team.id })}
              data-testid={`assignee-team-${team.id}`}
            >
              {team.name}
            </K.Item>
          ))}
        </>
      ) : null}
      <K.Separator />
      <K.Item
        onSelect={() => onAssign(null)}
        aria-current={isCurrent(null)}
        data-testid="assignee-unassign"
      >
        {t("unassign")}
      </K.Item>
      {routingNote ? (
        <p className="max-w-64 px-2 pb-1 pt-1.5 text-[10px] leading-snug text-muted-foreground">
          {t("routingSynced")}
        </p>
      ) : null}
    </>
  )
}

/**
 * The label catalog as toggles. `stateOf` is the label's state across the
 * targets (tri-state for a bulk selection); `onToggle` receives that state so
 * the caller can turn it into add / remove (`labelToggleAction`).
 */
export function LabelMenuItems({
  kit,
  stateOf,
  onToggle,
  onManage,
  keepOpen = true,
}: {
  kit: TriageMenuKit
  stateOf: (labelId: string) => LabelCheckState
  onToggle: (labelId: string, state: LabelCheckState) => void
  /** Opens the label manager; absent → no item. */
  onManage?: () => void
  /** A dropdown stays open between toggles (several labels in one visit). */
  keepOpen?: boolean
}) {
  const t = useTranslations("inbox.labels")
  const tMenu = useTranslations("inbox.triageMenu")
  const catalog = useConversationLabels()
  const K = kit
  const Heading = kit.Heading ?? kit.Label
  const swatch = (color: string | undefined) => (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full border"
      style={color ? { backgroundColor: color } : undefined}
    />
  )
  return (
    <>
      <Heading className="text-xs text-muted-foreground">{t("pickerTitle")}</Heading>
      {catalog.length === 0 ? (
        <Heading className="text-xs font-normal text-muted-foreground">{t("empty")}</Heading>
      ) : (
        catalog.map((label) => {
          const state = stateOf(label.id)
          if (K.CheckboxItem) {
            return (
              <K.CheckboxItem
                key={label.id}
                checked={state === "mixed" ? "indeterminate" : state === "checked"}
                onCheckedChange={() => onToggle(label.id, state)}
                onSelect={keepOpen ? (event) => event.preventDefault() : undefined}
                data-testid={`triage-label-${label.id}`}
              >
                <span className="flex items-center gap-1.5">
                  {swatch(label.color)}
                  {label.name}
                </span>
              </K.CheckboxItem>
            )
          }
          return (
            <K.Item
              key={label.id}
              onSelect={() => onToggle(label.id, state)}
              data-testid={`triage-label-${label.id}`}
            >
              {swatch(label.color)}
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
              <span className="text-xs text-muted-foreground" data-label-state={state}>
                {tMenu(`labelState.${state}`)}
              </span>
            </K.Item>
          )
        })
      )}
      {onManage ? (
        <>
          <K.Separator />
          <K.Item onSelect={onManage} data-testid="triage-label-manage">
            {t("manage")}
          </K.Item>
        </>
      ) : null}
    </>
  )
}
