"use client"

/**
 * The detail pane: one installation, one continuous dashboard.
 *
 * No tabs, for the reason `DeviceDetail` wrote down: most answers here are two
 * lines long, and putting each behind a click hides how little there is. The
 * sections are cards in a grid, so the short ones sit beside each other and
 * the wide ones take the full width.
 *
 * Layout rules carried over verbatim:
 *
 *  * The scroll container is `@container/console-pane`, and everything
 *    multi-column inside sizes off THAT, never the viewport. This pane is a
 *    draggable fraction of the window, so a viewport `sm:` here seats two
 *    columns in a 300px pane purely because the monitor is wide.
 *  * The masthead is outside the scroller, so the Bot you are looking at stays
 *    named however far down you are.
 *  * Switching Bots resets the scroll with `scrollTop`, not `scrollTo`: the
 *    latter is absent in jsdom and in the older Android WebViews the Capacitor
 *    shell still runs on.
 *
 * The three `BotResolutionProblem` kinds are stated separately rather than
 * collapsed into one "unavailable" line, because they need three different
 * actions: reinstall the plugin, accept a version that moved, or fix a handler
 * that never loaded.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import {
  HistoryIcon,
  IdCardIcon,
  InboxIcon,
  KeyRoundIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  ZapIcon,
} from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { FactList, FactRow } from "@/components/surface/fact-list"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotHero } from "./bot-hero"
import { BotConfigSection } from "./sections/config-section"
import { BotCredentialsSection } from "./sections/credentials-section"
import { BotDeliveriesSection } from "./sections/deliveries-section"
import { BotPolicySection } from "./sections/policy-section"
import { BotRunsSection } from "./sections/runs-section"
import { BotTriggersSection } from "./sections/triggers-section"
import { useBotProblemText, useBotRelativeTime } from "./bot-visuals"

export interface BotDetailProps {
  row: BotConsoleRow | null
  /** The installations read is still in flight — show a skeleton, not "pick one". */
  loading?: boolean
  /**
   * The URL named an installation that does not exist. Distinct from "nothing
   * selected": the link was followed and missed, and the pane says so rather
   * than greeting the reader with the pick-one copy as if nothing happened.
   */
  missing?: boolean
  /** Called after the installation is removed, so the console can deselect. */
  onUninstalled?: () => void
  /**
   * Nothing is installed at all. "Pick a Bot from the list" is a dead end
   * when the list is empty, so the pane offers the install flow instead.
   */
  empty?: boolean
  /** Opens the install sheet from the empty pane. */
  onInstall?: () => void
}

export function BotDetail({
  row,
  loading = false,
  missing = false,
  onUninstalled,
  empty = false,
  onInstall,
}: BotDetailProps) {
  const t = useTranslations("bots")
  const relative = useBotRelativeTime()
  const problemText = useBotProblemText()
  const scroller = useRef<HTMLDivElement>(null)
  const id = row?.id ?? null

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
  }, [id])

  if (loading && !row) {
    // Bars in the shape of the hero + first card row, not a spinner: the
    // pane's shape is known before its contents are.
    return (
      <div className="flex h-full flex-col gap-3.5 p-4" data-testid="bot-detail-loading">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-3.5">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    )
  }

  if (!row && empty && !missing) {
    return (
      <Empty className="h-full border-none" data-testid="bot-detail-none-installed">
        <EmptyHeader>
          <EmptyTitle>{t("detail.noneInstalledTitle")}</EmptyTitle>
          <EmptyDescription>{t("detail.noneInstalledBody")}</EmptyDescription>
        </EmptyHeader>
        {onInstall ? (
          <EmptyContent>
            <Button size="sm" onClick={onInstall} data-testid="bot-detail-install">
              {t("install.title")}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    )
  }

  if (!row) {
    return (
      <Empty className="h-full border-none" data-testid="bot-detail-empty">
        <EmptyHeader>
          <EmptyTitle>
            {missing ? t("detail.notFoundTitle") : t("detail.noSelectionTitle")}
          </EmptyTitle>
          <EmptyDescription>
            {missing ? t("detail.notFoundBody") : t("detail.noSelectionBody")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="@container/console-pane flex h-full min-h-0 flex-col" data-testid="bot-detail">
      <BotHero row={row} {...(onUninstalled ? { onUninstalled } : {})} />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {/* Installation-wide alerts sit above the grid, not inside a card:
            they are about the Bot, not about one of the questions below. */}
        {row.orphaned ? (
          <Alert className="mb-3.5" data-testid="bot-orphan-alert">
            <AlertTitle>{t("orphan.title")}</AlertTitle>
            <AlertDescription>{t("orphan.body")}</AlertDescription>
          </Alert>
        ) : null}
        {row.problems.map((problem) => {
          const { text, severe } = problemText(problem)
          return (
            <Alert
              key={problem.kind}
              variant={severe ? "destructive" : "default"}
              className="mb-3.5"
              data-testid={`bot-problem-${problem.kind}`}
            >
              <AlertTitle>{t(`problem.${problem.kind}.title`)}</AlertTitle>
              <AlertDescription>{text}</AlertDescription>
            </Alert>
          )
        })}

        {/* `items-start` so a short card keeps its own height instead of being
            stretched to match the tall one beside it. */}
        <div className="grid items-start gap-3.5 @3xl/console-pane:grid-cols-2">
          {/* Installation-facing facts only: source, executor and scope are
              the hero's meta line — repeating them here printed the same three
              answers twice, a screen-height apart. */}
          <ConsoleSection id="identity" title={t("overview.identity")} icon={IdCardIcon}>
            <FactList>
              <FactRow label={t("overview.definition")} mono>
                {row.definitionId}
              </FactRow>
              <FactRow label={t("overview.status")}>{t(`status.${row.status}`)}</FactRow>
              <FactRow label={t("overview.installation")} mono>
                {row.id}
              </FactRow>
              <FactRow label={t("overview.updated")}>{relative(row.updatedAt)}</FactRow>
              {row.triggers.some((trigger) => trigger.kind === "poll") && (
                <>
                  <FactRow label={t("monitor.activated")}>
                    {row.activatedAt ? relative(row.activatedAt) : t("monitor.notStarted")}
                  </FactRow>
                  <FactRow label={t("monitor.lastSuccess")}>
                    {row.monitor?.lastSuccessAt
                      ? relative(row.monitor.lastSuccessAt)
                      : t("monitor.neverSynced")}
                  </FactRow>
                  <FactRow label={t("monitor.health")}>
                    {row.monitor?.lastError ??
                      (row.monitor?.lastSuccessAt
                        ? t("monitor.healthy")
                        : t("monitor.awaitingSync"))}
                  </FactRow>
                  {row.monitor?.retryAt ? (
                    <FactRow label={t("monitor.retryAt")}>{relative(row.monitor.retryAt)}</FactRow>
                  ) : null}
                </>
              )}
            </FactList>
          </ConsoleSection>

          <ConsoleSection
            id="triggers"
            title={t("triggers.title")}
            icon={ZapIcon}
            description={t("triggers.description")}
            meta={t("row.armedOfTotal", { armed: row.armedTriggers, total: row.triggers.length })}
          >
            <BotTriggersSection row={row} />
          </ConsoleSection>

          <ConsoleSection
            id="credentials"
            title={t("credentials.title")}
            icon={KeyRoundIcon}
            description={t("credentials.description")}
            meta={
              row.requiredSlots.length > 0
                ? t("row.armedOfTotal", {
                    armed: row.requiredSlots.length - row.unboundSlots.length,
                    total: row.requiredSlots.length,
                  })
                : undefined
            }
          >
            <BotCredentialsSection row={row} />
          </ConsoleSection>

          <ConsoleSection
            id="config"
            title={t("config.title")}
            icon={SlidersHorizontalIcon}
            description={t("config.description")}
          >
            <BotConfigSection row={row} />
          </ConsoleSection>

          {/* Full width: the cockpit is a list beside a detail pane, and half a
              pane seats neither. */}
          <ConsoleSection
            id="runs"
            title={t("runs.title")}
            icon={HistoryIcon}
            description={t("runs.description")}
            wide
          >
            <BotRunsSection row={row} />
          </ConsoleSection>

          {/* Full width: each row can carry a whole error message, and in half
              a pane one of those is a paragraph. */}
          <ConsoleSection
            id="deliveries"
            title={t("delivery.title")}
            icon={InboxIcon}
            description={t("delivery.description")}
            meta={
              row.deadLetters > 0
                ? t("delivery.deadLetterCount", { count: row.deadLetters })
                : undefined
            }
            wide
          >
            <BotDeliveriesSection row={row} />
          </ConsoleSection>

          {/* Full width: a fact list of up to seven rows, each carrying a
              provenance badge, plus a refusal list underneath. In half a pane
              every value wraps under its own label. */}
          <ConsoleSection
            id="policy"
            title={t("policy.title")}
            icon={ShieldIcon}
            description={t("policy.description")}
            wide
          >
            <BotPolicySection row={row} />
          </ConsoleSection>
        </div>
      </div>
    </div>
  )
}
