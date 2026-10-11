"use client"

/**
 * The glance visual language (ADR-0225 §3): one container, hairline-separated
 * sections under small group titles, metrics as a horizontal stats strip,
 * status as an inline dot and label. No card, and never a card in a card.
 *
 * Rows carry `data-glance-nav` so the host's arrow-key navigation can walk
 * every actionable row in render order, and `data-glance-expand` when → / ←
 * should open or close them.
 */

import type { ReactNode } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ChevronRightIcon, CloudOffIcon, MonitorIcon } from "lucide-react"

import { GLANCE_MODULES } from "@/lib/glance/registry"
import { cn } from "@/lib/utils"
import type { GlanceModuleId } from "@/types/glance/layout"

import { useGlance } from "./glance-context"

/* ── Origin (paired phones) ──────────────────────────────────────────── */

/**
 * "MacBook · 2 min ago" beside a module built on the desktop. Shown only on a
 * paired phone (`originOf`), so a reading is never mistaken for this device's
 * own, and a reading kept from before the host dropped says so.
 */
export function GlanceOriginTag({ moduleId }: { moduleId: string }) {
  const { originOf, now } = useGlance()
  const t = useTranslations("glance.origin")
  const format = useFormatter()
  const origin = originOf?.(moduleId as GlanceModuleId) ?? null
  if (!origin || origin.kind !== "host") return null
  const age = format.relativeTime(origin.at, Math.max(now, origin.at))
  const label = origin.host
    ? t(origin.live ? "fromHost" : "fromHostOffline", { host: origin.host, age })
    : t(origin.live ? "fromDesktop" : "fromDesktopOffline", { age })
  return (
    <span
      data-testid={`glance-origin-${moduleId}`}
      data-live={origin.live}
      title={label}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 truncate text-[11px]",
        origin.live ? "text-muted-foreground/80" : "text-warning"
      )}
    >
      {origin.live ? (
        <MonitorIcon aria-hidden className="size-3 shrink-0" />
      ) : (
        <CloudOffIcon aria-hidden className="size-3 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * A module whose data this device cannot get, said in place (ADR-0225 §9):
 * the desktop is offline and nothing was received yet, or it does not serve
 * glance. One line, the module's title and the reason.
 */
export function GlanceUnavailableModule({ moduleId }: { moduleId: GlanceModuleId }) {
  const { originOf, platform } = useGlance()
  const t = useTranslations("glance")
  const origin = originOf?.(moduleId) ?? null
  const reason =
    origin?.kind === "unavailable" && origin.reason === "host-unsupported"
      ? t("origin.unsupported")
      : t("origin.offline")
  const title = t(GLANCE_MODULES[moduleId].labelKey)
  return (
    <section
      data-glance-module={moduleId}
      data-glance-unavailable
      aria-label={title}
      className={cn("min-w-0", platform === "mobile" ? "px-5 py-1.5" : "px-3.5 py-1")}
    >
      <div className={cn(rowClass(platform), "hover:bg-transparent")}>
        <span
          className={cn(
            "shrink-0 font-semibold text-muted-foreground",
            platform === "mobile" ? "w-14 text-[13px]" : "w-12 text-[11.5px]"
          )}
        >
          {title}
        </span>
        <CloudOffIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{reason}</span>
      </div>
    </section>
  )
}

/* ── Section ─────────────────────────────────────────────────────────── */

export interface GlanceSectionProps {
  moduleId: string
  title: string
  meta?: ReactNode
  aside?: ReactNode
  children: ReactNode
}

/** A module with a header line: title, optional meta, optional right-hand controls. */
export function GlanceSection({ moduleId, title, meta, aside, children }: GlanceSectionProps) {
  const { platform } = useGlance()
  return (
    <section
      data-glance-module={moduleId}
      aria-label={title}
      className={cn("min-w-0", platform === "mobile" ? "px-5 py-3" : "px-3.5 py-2.5")}
    >
      <header className="mb-1.5 flex min-h-5 items-center gap-2">
        <h3
          className={cn(
            "shrink-0 font-semibold tracking-wide text-muted-foreground",
            platform === "mobile" ? "text-[13px]" : "text-[11.5px]"
          )}
        >
          {title}
        </h3>
        {meta ? <div className="flex min-w-0 items-center gap-1.5">{meta}</div> : null}
        <GlanceOriginTag moduleId={moduleId} />
        <div className="min-w-0 flex-1" />
        {aside ? <div className="flex shrink-0 items-center gap-1.5">{aside}</div> : null}
      </header>
      {children}
    </section>
  )
}

/** A module rendered as one line: lead label, content, chevron. */
export function GlanceCompactSection({
  moduleId,
  title,
  children,
  onClick,
  trailing,
  label,
}: {
  moduleId: string
  title: string
  children: ReactNode
  onClick?: () => void
  trailing?: ReactNode
  /** Accessible name of the whole row, when it is a button. */
  label?: string
}) {
  const { platform } = useGlance()
  const body = (
    <>
      <span
        className={cn(
          "shrink-0 font-semibold text-muted-foreground",
          platform === "mobile" ? "w-14 text-[13px]" : "w-12 text-[11.5px]"
        )}
      >
        {title}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
        {children}
      </span>
      <GlanceOriginTag moduleId={moduleId} />
      {trailing}
      {onClick ? (
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
      ) : null}
    </>
  )
  return (
    <section
      data-glance-module={moduleId}
      aria-label={title}
      className={cn("min-w-0", platform === "mobile" ? "px-5 py-1.5" : "px-3.5 py-1")}
    >
      {onClick ? (
        <button
          type="button"
          data-glance-nav
          aria-label={label}
          onClick={onClick}
          className={rowClass(platform)}
        >
          {body}
        </button>
      ) : (
        <div className={cn(rowClass(platform), "hover:bg-transparent")}>{body}</div>
      )}
    </section>
  )
}

/* ── Rows ────────────────────────────────────────────────────────────── */

function rowClass(platform: "desktop" | "mobile"): string {
  return cn(
    "-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left",
    "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
    "focus-visible:ring-2 focus-visible:ring-ring/50",
    platform === "mobile" ? "min-h-11 py-2 text-[15px]" : "min-h-7 py-1 text-[13px]"
  )
}

export interface GlanceRowProps {
  leading?: ReactNode
  children: ReactNode
  sub?: ReactNode
  trailing?: ReactNode
  onClick?: () => void
  /** Present when the row expands in place (→ / ← and the chevron direction). */
  expanded?: boolean
  /** Key the host's → / ← toggles. */
  expandKey?: string
  /** Accessible name when the visible text is not enough. */
  label?: string
  testId?: string
  className?: string
}

/** One actionable (or static) line. */
export function GlanceRow({
  leading,
  children,
  sub,
  trailing,
  onClick,
  expanded,
  expandKey,
  label,
  testId,
  className,
}: GlanceRowProps) {
  const { platform } = useGlance()
  // Expandable rows always show the chevron (rotated when open); plain rows
  // show it only when they navigate somewhere.
  const chevron = expanded !== undefined || Boolean(onClick)
  const content = (
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {sub ? (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-muted-foreground",
            platform === "mobile" ? "text-[13px]" : "text-[11.5px]"
          )}
        >
          {sub}
        </span>
      ) : null}
      {trailing}
      {chevron ? (
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90"
          )}
        />
      ) : null}
    </>
  )
  if (!onClick) {
    return (
      <div
        data-testid={testId}
        className={cn(rowClass(platform), "hover:bg-transparent", className)}
      >
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-glance-nav
      data-glance-expand={expandKey}
      data-testid={testId}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(rowClass(platform), className)}
    >
      {content}
    </button>
  )
}

/* ── Stats strip ─────────────────────────────────────────────────────── */

export type GlanceTone = "default" | "warn" | "crit" | "ok" | "muted"

const TONE_TEXT: Record<GlanceTone, string> = {
  default: "text-foreground",
  warn: "text-warning",
  crit: "text-destructive",
  ok: "text-success",
  muted: "text-muted-foreground",
}

export interface GlanceStat {
  key: string
  label: string
  value: string
  sub?: string
  tone?: GlanceTone
  onClick?: () => void
  /** Accessible name for the clickable stat. */
  actionLabel?: string
}

/**
 * Numbers in a row, hairline-separated. At the narrow width the strip becomes
 * a list of label / value lines unless `keepRow` (short counts stay a row).
 */
export function GlanceStats({
  stats,
  keepRow = false,
}: {
  stats: GlanceStat[]
  keepRow?: boolean
}) {
  const { width, platform } = useGlance()
  const stacked = width === "narrow" && !keepRow && platform === "desktop"
  return (
    <div
      className={cn("mb-1.5 grid", stacked ? "grid-cols-1" : "")}
      style={
        stacked ? undefined : { gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }
      }
    >
      {stats.map((stat, index) => {
        const inner = stacked ? (
          <>
            <span className="text-[11.5px] text-muted-foreground">{stat.label}</span>
            <span className="flex-1" />
            <span className={cn("font-semibold tabular-nums", TONE_TEXT[stat.tone ?? "default"])}>
              {stat.value}
            </span>
            {stat.sub ? (
              <span className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">
                {stat.sub}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span
              className={cn(
                "block whitespace-nowrap text-muted-foreground",
                platform === "mobile" ? "text-[12.5px]" : "text-[11px]"
              )}
            >
              {stat.label}
            </span>
            <span
              className={cn(
                "block font-semibold tracking-tight tabular-nums",
                platform === "mobile" ? "text-[19px]" : "text-base",
                TONE_TEXT[stat.tone ?? "default"]
              )}
            >
              {stat.value}
            </span>
            {stat.sub ? (
              <span
                className={cn(
                  "block whitespace-nowrap tabular-nums text-muted-foreground/80",
                  platform === "mobile" ? "text-[12.5px]" : "text-[11px]"
                )}
              >
                {stat.sub}
              </span>
            ) : null}
          </>
        )
        const className = cn(
          "min-w-0 rounded-md text-left",
          stacked ? "flex items-baseline gap-2 py-0.5" : "px-2.5 py-0.5",
          !stacked && index === 0 && "pl-0",
          !stacked && index > 0 && "border-l border-border",
          stat.onClick &&
            "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        )
        return stat.onClick ? (
          <button
            key={stat.key}
            type="button"
            data-glance-nav
            aria-label={stat.actionLabel}
            onClick={stat.onClick}
            className={className}
          >
            {inner}
          </button>
        ) : (
          <div key={stat.key} className={className}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}

/* ── Small marks ─────────────────────────────────────────────────────── */

export type GlanceDotTone = "run" | "warn" | "err" | "info" | "ok" | "idle"

const DOT_CLASS: Record<GlanceDotTone, string> = {
  run: "bg-success",
  warn: "bg-warning",
  err: "bg-destructive",
  info: "bg-info",
  ok: "bg-success",
  idle: "bg-muted-foreground/50",
}

export function GlanceDot({ tone, pulse = false }: { tone: GlanceDotTone; pulse?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-2 shrink-0">
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-40 motion-reduce:hidden",
            DOT_CLASS[tone]
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT_CLASS[tone])} />
    </span>
  )
}

export type GlanceTagTone = "neutral" | "warn" | "crit" | "ok"

const TAG_CLASS: Record<GlanceTagTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  warn: "bg-warning/15 text-warning",
  crit: "bg-destructive/10 text-destructive",
  ok: "bg-success/15 text-success",
}

export function GlanceTag({
  tone = "neutral",
  children,
  title,
}: {
  tone?: GlanceTagTone
  children: ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "shrink-0 whitespace-nowrap rounded px-1.5 text-[10.5px] leading-[17px]",
        TAG_CLASS[tone]
      )}
    >
      {children}
    </span>
  )
}

/** A thin usage bar. `pct` is the share USED, 0-100. */
export function GlanceMeter({
  pct,
  severity,
  label,
}: {
  pct: number
  severity: "ok" | "warn" | "crit" | "muted"
  label: string
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full",
          severity === "crit"
            ? "bg-destructive"
            : severity === "warn"
              ? "bg-warning"
              : severity === "muted"
                ? "bg-muted-foreground/40"
                : "bg-foreground/70"
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** A 7-ish point trend line. Flat when every value is equal. */
export function GlanceSparkline({
  values,
  width = 88,
  height = 22,
  label,
}: {
  values: number[]
  width?: number
  height?: number
  label: string
}) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const points = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`
    )
    .join(" ")
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 text-muted-foreground"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** A small text-button for light actions inside a module header or row. */
export function GlanceLinkButton({
  children,
  onClick,
  label,
}: {
  children: ReactNode
  onClick: () => void
  label?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded text-[12px] text-[var(--link)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
    </button>
  )
}
