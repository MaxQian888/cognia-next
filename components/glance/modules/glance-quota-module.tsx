"use client"

/**
 * Quota module: every quota source, one vocabulary, honest about age
 * (ADR-0225 §5). Meters show the share USED, the providers' own convention.
 *
 * Light actions only: retry an errored source, turn queries on for a vault
 * account (`disabled`), or go set up a login found on this machine
 * (`discovered`, which adopts credentials and therefore belongs to the
 * subscription page).
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"

import { Spinner } from "@/components/ui/spinner"
import type { GlanceQuotaSource, GlanceQuotaWindow } from "@/lib/glance/snapshot"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import {
  GlanceCompactSection,
  GlanceDot,
  GlanceLinkButton,
  GlanceMeter,
  GlanceRow,
  GlanceSection,
  GlanceTag,
  type GlanceDotTone,
} from "../glance-primitives"

const INLINE_WINDOWS = 2

function meterSeverity(
  window: GlanceQuotaWindow,
  stale: boolean
): "ok" | "warn" | "crit" | "muted" {
  if (stale) return "muted"
  if (window.severity === "exceeded" || window.severity === "crit") return "crit"
  if (window.severity === "warn") return "warn"
  return "ok"
}

function dotOf(source: GlanceQuotaSource): GlanceDotTone {
  switch (source.state) {
    case "exhausted":
    case "error":
      return "err"
    case "warn":
      return "warn"
    case "ok":
      return "info"
    default:
      return "idle"
  }
}

export function GlanceQuotaModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.quota")
  const tRoot = useTranslations()
  const format = useFormatter()
  const { snapshot, send, route, now } = useGlance()
  const quota = snapshot.quota
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const title = t("label")
  const globalTag =
    snapshot.config.scope === "workspace" ? (
      <GlanceTag title={t("globalHint")}>{t("global")}</GlanceTag>
    ) : null

  const providerName = (provider: string) => {
    const key = `subscription.providers.${provider}`
    return tRoot.has(key) ? tRoot(key) : provider
  }
  const windowLabel = (w: GlanceQuotaWindow) =>
    w.labelKey && tRoot.has(w.labelKey) ? tRoot(w.labelKey) : (w.label ?? w.id)

  const act = async (key: string, run: () => Promise<string | null>) => {
    setBusy((prev) => new Set(prev).add(key))
    setFailed((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    const errorKey = await run()
    setBusy((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    if (errorKey) setFailed((prev) => new Set(prev).add(key))
  }

  if (!quota) {
    return (
      <GlanceCompactSection moduleId="quota" title={title}>
        <span className="text-muted-foreground">{t("loading")}</span>
      </GlanceCompactSection>
    )
  }

  const openSettings = () => route({ kind: "open-owner", owner: "subscription" })

  if (size === "compact") {
    const shown = quota.sources.filter((s) => s.state !== "discovered" && s.state !== "disabled")
    return (
      <GlanceCompactSection
        moduleId="quota"
        title={title}
        label={t("open")}
        onClick={openSettings}
        trailing={globalTag}
      >
        {shown.length === 0 ? <span className="text-muted-foreground">{t("none")}</span> : null}
        {shown.map((source, index) => {
          const worst = source.windows.reduce<number | null>(
            (acc, w) => (w.usedPct == null ? acc : Math.max(acc ?? 0, w.usedPct)),
            null
          )
          return (
            <span key={source.key} className="flex shrink-0 items-center gap-1">
              {index > 0 ? <span className="text-muted-foreground/60">·</span> : null}
              <span>{providerName(source.provider)}</span>
              {source.state === "error" ? (
                <span className="text-destructive">{t("state.error")}</span>
              ) : source.state === "refreshing" ? (
                <span className="text-muted-foreground">…</span>
              ) : worst != null ? (
                <b
                  className={
                    source.state === "stale"
                      ? "font-semibold tabular-nums text-muted-foreground"
                      : worst >= 90
                        ? "font-semibold tabular-nums text-destructive"
                        : worst >= 70
                          ? "font-semibold tabular-nums text-warning"
                          : "font-semibold tabular-nums"
                  }
                >
                  {Math.round(worst)}%
                </b>
              ) : null}
            </span>
          )
        })}
      </GlanceCompactSection>
    )
  }

  const renderWindow = (source: GlanceQuotaSource, w: GlanceQuotaWindow) => {
    const reset = w.resetAt
      ? t("resetsIn", { when: format.relativeTime(new Date(w.resetAt), now) })
      : null
    if (w.usedPct == null) {
      const amount =
        w.remaining == null
          ? "—"
          : w.currency
            ? format.number(w.remaining, { style: "currency", currency: w.currency })
            : `${format.number(w.remaining)}${w.unit ? ` ${w.unit}` : ""}`
      return (
        <div
          key={w.id}
          className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 py-px text-[11.5px] text-muted-foreground"
        >
          <span className="truncate">{windowLabel(w)}</span>
          <span className="tabular-nums text-foreground">{amount}</span>
          <span>{reset}</span>
        </div>
      )
    }
    return (
      <div
        key={w.id}
        className="grid grid-cols-[4.5rem_1fr_4.25rem_auto] items-center gap-2 py-px text-[11.5px] text-muted-foreground"
        style={source.state === "error" ? { opacity: 0.55 } : undefined}
      >
        <span className="truncate">{windowLabel(w)}</span>
        <GlanceMeter
          pct={w.usedPct}
          severity={meterSeverity(w, source.state === "stale")}
          label={t("meterLabel", { name: providerName(source.provider), window: windowLabel(w) })}
        />
        <span className="text-right tabular-nums text-foreground">
          {t("used", { pct: Math.round(w.usedPct) })}
        </span>
        <span className="whitespace-nowrap">{reset}</span>
      </div>
    )
  }

  return (
    <GlanceSection
      moduleId="quota"
      title={title}
      meta={globalTag}
      aside={<GlanceLinkButton onClick={openSettings}>{t("manage")}</GlanceLinkButton>}
    >
      {quota.sources.length === 0 ? (
        <GlanceRow onClick={openSettings}>
          <span className="text-muted-foreground">{t("none")}</span>
        </GlanceRow>
      ) : null}
      {quota.sources.map((source, index) => {
        const name = providerName(source.provider)
        const isBusy = busy.has(source.key)
        const didFail = failed.has(source.key)
        const separator = index > 0 ? "border-t border-dashed border-border" : ""

        if (source.state === "discovered") {
          return (
            <div key={source.key} className={`py-0.5 ${separator}`}>
              <GlanceRow
                leading={<GlanceDot tone="idle" />}
                sub={t("discoveredHint")}
                trailing={<GlanceLinkButton onClick={openSettings}>{t("setUp")}</GlanceLinkButton>}
              >
                {name}
              </GlanceRow>
            </div>
          )
        }

        if (source.state === "disabled") {
          return (
            <div key={source.key} className={`py-0.5 ${separator}`}>
              <GlanceRow
                leading={<GlanceDot tone="idle" />}
                sub={source.accountLabel ?? undefined}
                trailing={
                  isBusy ? (
                    <Spinner label={t("enabling")} className="size-3.5 text-muted-foreground" />
                  ) : (
                    <GlanceLinkButton
                      label={t("enableFor", { name })}
                      onClick={() =>
                        void act(source.key, () =>
                          send({
                            kind: "quota-enable",
                            provider: source.provider,
                            accountId: source.accountId ?? "",
                          })
                        )
                      }
                    >
                      {didFail ? t("retryEnable") : t("enable")}
                    </GlanceLinkButton>
                  )
                }
              >
                {name}
              </GlanceRow>
            </div>
          )
        }

        const open = size === "expanded" || expanded.has(source.key)
        const windows = open ? source.windows : source.windows.slice(0, INLINE_WINDOWS)
        // Retry sits beside the row, never inside it: the row is itself a
        // button (it expands), and a button inside a button is invalid HTML
        // that screen readers flatten into one control.
        const canRetry = !isBusy && (source.state === "error" || source.state === "stale")
        return (
          <div key={source.key} className={`py-0.5 ${separator}`}>
            <div className="flex min-w-0 items-center gap-1">
              <div className="min-w-0 flex-1">
                <GlanceRow
                  testId={`glance-quota-source-${source.key}`}
                  leading={<GlanceDot tone={dotOf(source)} />}
                  expanded={size === "expanded" ? undefined : open}
                  expandKey={size === "expanded" ? undefined : source.key}
                  onClick={
                    size === "expanded"
                      ? undefined
                      : () =>
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(source.key)) next.delete(source.key)
                            else next.add(source.key)
                            return next
                          })
                  }
                  label={t(open ? "collapse" : "expand", { name })}
                  trailing={
                    <>
                      {source.state === "error" ? (
                        <GlanceTag tone="crit">{t("state.error")}</GlanceTag>
                      ) : null}
                      {source.state === "exhausted" ? (
                        <GlanceTag tone="crit">{t("state.exhausted")}</GlanceTag>
                      ) : null}
                      {source.state === "stale" && source.fetchedAt ? (
                        <GlanceTag>
                          {t("state.stale", {
                            when: format.relativeTime(new Date(source.fetchedAt), now),
                          })}
                        </GlanceTag>
                      ) : null}
                      {source.state === "refreshing" || isBusy ? (
                        <Spinner
                          label={t("refreshing")}
                          className="size-3.5 text-muted-foreground"
                        />
                      ) : null}
                    </>
                  }
                >
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0">{name}</span>
                    {source.accountLabel ? (
                      <span className="truncate text-[11.5px] text-muted-foreground">
                        {source.accountLabel}
                      </span>
                    ) : null}
                  </span>
                </GlanceRow>
              </div>
              {canRetry ? (
                <button
                  type="button"
                  data-glance-nav
                  aria-label={t("retryFor", { name })}
                  onClick={() =>
                    void act(source.key, () => send({ kind: "quota-refresh", key: source.key }))
                  }
                  className="shrink-0 rounded px-1.5 text-[11.5px] leading-5 text-[var(--link)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {t("retry")}
                </button>
              ) : null}
            </div>
            {open && source.error ? (
              <p className="pb-1 pl-4 text-[11.5px] text-destructive">{source.error}</p>
            ) : null}
            {windows.map((w) => renderWindow(source, w))}
            {open ? (
              <p className="py-0.5 text-[11px] text-muted-foreground/80">
                {source.fetchedAt
                  ? source.state === "error"
                    ? t("lastGood", { when: format.relativeTime(new Date(source.fetchedAt), now) })
                    : t("updated", { when: format.relativeTime(new Date(source.fetchedAt), now) })
                  : t("noReading")}
              </p>
            ) : null}
            {didFail ? (
              <p className="pb-1 text-[11.5px] text-destructive">{t("refreshFailed")}</p>
            ) : null}
          </div>
        )
      })}
    </GlanceSection>
  )
}
