"use client"

/**
 * Fleet module: a read-only summary of what the island holds (ADR-0225 §1).
 *
 * Counts and the most recent rows, nothing else. There is deliberately no
 * approve, answer or stop control here: every click opens Agent Fleet (the
 * island) on that task, which is the one place those controls live. The test
 * pins that this module renders no such control.
 */

import { useFormatter, useTranslations } from "next-intl"
import { ExternalLinkIcon } from "lucide-react"

import type { GlanceFleetRow, GlanceFleetState } from "@/lib/glance/snapshot"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import {
  GlanceCompactSection,
  GlanceDot,
  GlanceLinkButton,
  GlanceRow,
  GlanceSection,
  GlanceStats,
  GlanceTag,
  type GlanceDotTone,
} from "../glance-primitives"

const ROWS: Record<GlanceModuleSize, number> = { compact: 0, standard: 3, expanded: 6 }

const DOT: Record<GlanceFleetState, GlanceDotTone> = {
  working: "run",
  awaiting: "warn",
  failed: "err",
  done: "ok",
  idle: "idle",
  stale: "idle",
}

export function GlanceFleetModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.fleet")
  const tAgents = useTranslations("fleet.agents")
  const format = useFormatter()
  const { snapshot, route, now } = useGlance()
  const fleet = snapshot.fleet
  const title = t("label")

  const agentName = (row: GlanceFleetRow): string | null => {
    if (row.agentLabel) return row.agentLabel
    if (!row.agent) return null
    return tAgents.has(row.agent) ? tAgents(row.agent) : row.agent
  }

  if (!fleet) {
    return (
      <GlanceCompactSection moduleId="fleet" title={title}>
        <span className="text-muted-foreground">{t("loading")}</span>
      </GlanceCompactSection>
    )
  }

  const { counts } = fleet

  if (size === "compact") {
    return (
      <GlanceCompactSection
        moduleId="fleet"
        title={title}
        label={t("openFleet")}
        onClick={() => route({ kind: "open-fleet" })}
      >
        <GlanceDot tone={counts.working > 0 ? "run" : "idle"} pulse={counts.working > 0} />
        <span className="tabular-nums">{t("working", { count: counts.working })}</span>
        {counts.awaiting > 0 ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <GlanceDot tone="warn" />
            <span className="tabular-nums">{t("awaiting", { count: counts.awaiting })}</span>
          </>
        ) : null}
        {counts.failed > 0 ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <GlanceDot tone="err" />
            <span className="tabular-nums">{t("failed", { count: counts.failed })}</span>
          </>
        ) : null}
      </GlanceCompactSection>
    )
  }

  const rows = fleet.rows.slice(0, ROWS[size])
  const more = fleet.total - rows.length

  return (
    <GlanceSection
      moduleId="fleet"
      title={title}
      meta={<span className="truncate text-[11px] text-muted-foreground/80">{t("readOnly")}</span>}
      aside={
        <GlanceLinkButton label={t("openFleet")} onClick={() => route({ kind: "open-fleet" })}>
          {t("fleetLink")}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </GlanceLinkButton>
      }
    >
      <GlanceStats
        keepRow
        stats={[
          {
            key: "working",
            label: t("stat.working"),
            value: String(counts.working),
            onClick: () => route({ kind: "open-fleet", filter: "working" }),
            actionLabel: t("openFiltered", { state: t("stat.working") }),
          },
          {
            key: "awaiting",
            label: t("stat.awaiting"),
            value: String(counts.awaiting),
            tone: counts.awaiting > 0 ? "warn" : "default",
            onClick: () => route({ kind: "open-fleet", filter: "awaiting" }),
            actionLabel: t("openFiltered", { state: t("stat.awaiting") }),
          },
          {
            key: "failed",
            label: t("stat.failed"),
            value: String(counts.failed),
            tone: counts.failed > 0 ? "crit" : "default",
            onClick: () => route({ kind: "open-fleet", filter: "failed" }),
            actionLabel: t("openFiltered", { state: t("stat.failed") }),
          },
        ]}
      />
      {rows.length === 0 ? (
        <GlanceRow>
          <span className="text-muted-foreground">{t("empty")}</span>
        </GlanceRow>
      ) : null}
      {rows.map((row) => {
        const agent = agentName(row)
        const age = format.relativeTime(new Date(row.waitingSince ?? row.updatedAt), now)
        return (
          <GlanceRow
            key={row.id}
            testId={`glance-fleet-row-${row.id}`}
            label={t("openRow", { title: row.title })}
            leading={<GlanceDot tone={DOT[row.state]} pulse={row.state === "working"} />}
            trailing={
              row.state === "awaiting" ? (
                <GlanceTag tone="warn">{t("state.awaiting")}</GlanceTag>
              ) : row.state === "failed" ? (
                <GlanceTag tone="crit">{t("state.failed")}</GlanceTag>
              ) : row.state === "stale" ? (
                <GlanceTag>{t("state.stale")}</GlanceTag>
              ) : null
            }
            sub={agent ? `${agent} · ${age}` : age}
            onClick={() => route({ kind: "open-fleet", rowId: row.id })}
          >
            {row.title}
          </GlanceRow>
        )
      })}
      {more > 0 ? (
        <GlanceRow label={t("openFleet")} onClick={() => route({ kind: "open-fleet" })}>
          <span className="text-muted-foreground">{t("more", { count: more })}</span>
        </GlanceRow>
      ) : null}
    </GlanceSection>
  )
}
