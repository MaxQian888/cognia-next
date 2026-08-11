// Journal tab: the pet's diary — the activity ledger (`petActivityLog`,
// written on every XP-bearing event since v67 but never surfaced before)
// grouped by local day, newest first, with per-day event/XP totals. Read
// reactively so a fresh interaction appears while the tab is open.

"use client"

import { useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BellIcon,
  BotIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CookieIcon,
  DropletsIcon,
  EyeIcon,
  Gamepad2Icon,
  HandHeartIcon,
  HeartPulseIcon,
  InboxIcon,
  MessageCircleIcon,
  MoonIcon,
  SparklesIcon,
  TargetIcon,
  TrendingUpIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { listPetActivity } from "@/lib/db/pet"
import { localDayKey } from "@/lib/pet/economy/streak"
import type { PetActivityRow } from "@/types/pet"

/** Ledger rows shown per visit — ~2 weeks of active use; the table caps at 2000. */
const JOURNAL_ROWS = 300

/** Kinds with an authored `pet.journal.kinds.<kind>` label (XP-bearing set). */
const KIND_ICONS: Record<string, LucideIcon> = {
  review: EyeIcon,
  success: CheckCircle2Icon,
  goalProgress: TrendingUpIcon,
  goalComplete: TargetIcon,
  teamRun: BotIcon,
  workflowRun: WorkflowIcon,
  inboundMessage: InboxIcon,
  scheduledRun: CalendarClockIcon,
  scheduledRunStarting: BellIcon,
  fed: CookieIcon,
  played: Gamepad2Icon,
  petted: HandHeartIcon,
  talked: MessageCircleIcon,
  slept: MoonIcon,
  cleaned: DropletsIcon,
  treated: HeartPulseIcon,
}

interface DayGroup {
  day: string
  /** Epoch ms of the newest row in the group (formats the heading). */
  ts: number
  rows: PetActivityRow[]
  totalXp: number
}

/** Group newest-first rows into contiguous local-day sections. Pure. */
export function groupByLocalDay(rows: PetActivityRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const row of rows) {
    const day = localDayKey(row.ts)
    const last = groups[groups.length - 1]
    if (last && last.day === day) {
      last.rows.push(row)
      last.totalXp += row.xp
    } else {
      groups.push({ day, ts: row.ts, rows: [row], totalXp: row.xp })
    }
  }
  return groups
}

export function JournalTab() {
  const t = useTranslations("pet")
  const locale = useLocale()
  const rows = useLiveQuery(() => listPetActivity(JOURNAL_ROWS), [])

  if (!rows) {
    return (
      <Empty data-testid="pet-journal-loading" className="py-8">
        <EmptyDescription>{t("journal.loading")}</EmptyDescription>
      </Empty>
    )
  }
  if (rows.length === 0) {
    return (
      <Empty data-testid="pet-journal-empty" className="py-8">
        <EmptyDescription>{t("journal.empty")}</EmptyDescription>
      </Empty>
    )
  }

  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" })
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" })

  return (
    <div data-testid="pet-journal" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {groupByLocalDay(rows).map((group) => (
        <section key={group.day} data-journal-day={group.day} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {dayFormat.format(group.ts)}
            </h3>
            <Badge variant="secondary" className="tabular-nums">
              {t("journal.dayTotals", { count: group.rows.length, xp: group.totalXp })}
            </Badge>
          </div>
          <ItemGroup>
            {group.rows.map((row) => {
              const Icon = KIND_ICONS[row.kind] ?? SparklesIcon
              const known = row.kind in KIND_ICONS
              return (
                <Item
                  key={row.id ?? `${row.kind}-${row.ts}`}
                  data-journal-entry={row.kind}
                  size="sm"
                  className="min-w-0 px-0"
                >
                  <ItemMedia>
                    <Icon className="size-4 text-primary" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="max-w-full truncate">
                      {known ? t(`journal.kinds.${row.kind}`) : row.kind}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions className="shrink-0 flex-wrap justify-end">
                    {row.xp > 0 ? (
                      <Badge variant="outline" className="tabular-nums">
                        {t("journal.xp", { xp: row.xp })}
                      </Badge>
                    ) : null}
                    <time className="text-xs tabular-nums text-muted-foreground">
                      {timeFormat.format(row.ts)}
                    </time>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        </section>
      ))}
    </div>
  )
}
