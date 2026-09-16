"use client"

/**
 * What this Bot has actually done, from the one cockpit that answers that
 * question for everything else.
 *
 * A Bot run IS an `ExecutionRun` (`kind: "bot"`, `sourceId` the installation),
 * so it already appears on `/agent-runs` beside every other kind of run with
 * the same detail pane, the same `allowedActions` and the same `?run=` id
 * space. A list here would be a second implementation of a history that
 * already exists, and the two would drift the first time a control verb moved.
 *
 * So this is `AgentRunsPanel` with the installation pinned, the same shape the
 * `/squads` Runs tab already uses. `?run=` deep links stay shared, which is
 * what lets a notification card open the same run from either page.
 *
 * Selection is local rather than a query parameter. `?bot=` already owns this
 * route's URL, and a second parameter would make a link to a Bot and a link to
 * one of its runs the same length while meaning different things.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useElementWidth } from "@/hooks/use-element-width"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

/**
 * The narrowest card that honestly seats the embedded cockpit's split: a
 * 384px (`max-w-sm`) run list plus ~336px of run detail. Below it the panel
 * collapses to list-plus-drawer — decided by THIS width, not the viewport's,
 * because a card in a draggable pane can be narrow on a very wide monitor.
 */
const SIDE_BY_SIDE_MIN_PX = 720

export function BotRunsSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const box = useRef<HTMLDivElement>(null)
  const width = useElementWidth(box)

  if (row.orphaned) {
    // The runs exist and are still readable on `/agent-runs`. What is gone is
    // the definition that would say what any of them were, so pointing at the
    // full cockpit is more use than an empty pane here.
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("runs.orphanTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("runs.orphanBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    // A fixed height rather than `flex-1`: this section is one card in a grid
    // that scrolls as a whole, so an unbounded panel would stretch the card to
    // whatever the run list happened to be.
    <div ref={box} className="h-[26rem] min-h-0 overflow-hidden" data-testid="bot-runs">
      <AgentRunsPanel
        embedded
        // `0` is "not yet measured" — keep the panel's own viewport answer
        // until the first layout pass, rather than collapsing to compact for
        // one commit.
        compact={width > 0 ? width < SIDE_BY_SIDE_MIN_PX : undefined}
        filterKind="bot"
        botInstallationId={row.id}
        {...(runId ? { selectedId: runId } : {})}
        onSelect={(id) => setRunId(id ?? undefined)}
      />
    </div>
  )
}
