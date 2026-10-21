"use client"

/**
 * Agenda module: next scheduled run, unread notifications, connectivity
 * (ADR-0225 §2). A responsive strip in `compact`, three rows in `standard`. Each part
 * routes to its own owner: the scheduler (selected on the task), the
 * notification center, and the connectivity settings.
 */

import { useFormatter, useTranslations } from "next-intl"
import { BellIcon, ClockIcon, LinkIcon } from "lucide-react"

import type { GlanceAgendaSlice } from "@/lib/glance/snapshot"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import {
  GlanceDot,
  GlanceRow,
  GlanceSection,
  GlanceTag,
  type GlanceDotTone,
} from "../glance-primitives"

function connectivityTone(
  state: GlanceAgendaSlice["connectivity"]["state"],
  connected: number
): GlanceDotTone {
  if (state === "offline") return "err"
  if (state === "unpaired") return "idle"
  if (state === "remote") return "info"
  return connected > 0 ? "ok" : "warn"
}

export function GlanceAgendaModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.agenda")
  const format = useFormatter()
  const { snapshot, route, now, platform } = useGlance()
  const agenda = snapshot.agenda
  const title = t("label")

  if (!agenda) {
    return (
      <GlanceSection moduleId="agenda" title={title}>
        <GlanceRow>
          <span className="text-muted-foreground">{t("loading")}</span>
        </GlanceRow>
      </GlanceSection>
    )
  }

  const openScheduler = () =>
    route({
      kind: "open-owner",
      owner: "scheduler",
      ...(agenda.nextRun ? { itemId: agenda.nextRun.itemId } : {}),
    })
  const openNotifications = () => route({ kind: "open-owner", owner: "notifications" })
  const openConnectivity = () => route({ kind: "open-owner", owner: "connectivity" })

  const nextText = !agenda.schedulerLocal
    ? t("schedulerRemote")
    : agenda.nextRun
      ? t("next", {
          time: format.dateTime(new Date(agenda.nextRun.at), {
            hour: "2-digit",
            minute: "2-digit",
          }),
          name: agenda.nextRun.name,
        })
      : t("noneScheduled")
  const { connectivity } = agenda
  const connectivityText =
    connectivity.state === "offline"
      ? t("connectivity.offline")
      : connectivity.state === "remote"
        ? t("connectivity.remote")
        : connectivity.state === "unpaired"
          ? t("connectivity.unpaired")
          : t("connectivity.paired", {
              connected: connectivity.connected,
              total: connectivity.total,
            })
  const tone = connectivityTone(connectivity.state, connectivity.connected)

  if (size === "compact") {
    const chip =
      "inline-flex w-full min-w-0 items-center gap-1 overflow-hidden rounded px-1 py-0.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    return (
      <section
        data-glance-module="agenda"
        aria-label={title}
        className={platform === "mobile" ? "@container px-5 py-1.5" : "@container px-3.5 py-1"}
      >
        <div className="grid min-h-7 min-w-0 grid-cols-2 items-center gap-x-2 gap-y-1 text-[13px] @min-[420px]:grid-cols-3">
          <button
            type="button"
            data-glance-nav
            className={`${chip} col-span-2 @min-[420px]:col-span-1`}
            onClick={openScheduler}
            aria-label={t("openScheduler")}
            title={nextText}
          >
            <ClockIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{nextText}</span>
          </button>
          <button
            type="button"
            data-glance-nav
            className={chip}
            onClick={openNotifications}
            aria-label={t("openNotifications")}
            title={t("unread", { count: agenda.unread })}
          >
            <BellIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate tabular-nums">{t("unread", { count: agenda.unread })}</span>
          </button>
          <button
            type="button"
            data-glance-nav
            className={chip}
            onClick={openConnectivity}
            aria-label={t("openConnectivity")}
            title={connectivityText}
          >
            <GlanceDot tone={tone} />
            <span className="truncate">{connectivityText}</span>
          </button>
        </div>
      </section>
    )
  }

  return (
    <GlanceSection moduleId="agenda" title={title}>
      <GlanceRow
        leading={<ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        sub={agenda.nextRun ? format.relativeTime(new Date(agenda.nextRun.at), now) : undefined}
        trailing={
          agenda.lastOutcome ? (
            <GlanceTag
              tone={agenda.lastOutcome.ok ? "ok" : "crit"}
              title={t("lastOutcomeHint", {
                name: agenda.lastOutcome.name,
                when: format.relativeTime(new Date(agenda.lastOutcome.at), now),
              })}
            >
              {agenda.lastOutcome.ok ? t("lastOk") : t("lastFailed")}
            </GlanceTag>
          ) : null
        }
        label={t("openScheduler")}
        onClick={openScheduler}
      >
        {nextText}
      </GlanceRow>
      <GlanceRow
        leading={<BellIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        sub={agenda.latestUnreadTitle ?? undefined}
        label={t("openNotifications")}
        onClick={openNotifications}
      >
        <span className="tabular-nums">{t("unread", { count: agenda.unread })}</span>
      </GlanceRow>
      <GlanceRow
        leading={<LinkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        sub={
          connectivity.lastContactAt && connectivity.state === "paired"
            ? t("lastContact", {
                when: format.relativeTime(new Date(connectivity.lastContactAt), now),
              })
            : undefined
        }
        trailing={<GlanceDot tone={tone} />}
        label={t("openConnectivity")}
        onClick={openConnectivity}
      >
        {connectivityText}
      </GlanceRow>
    </GlanceSection>
  )
}
