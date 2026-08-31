"use client"

/**
 * `UsageDiagnosticsCard` — the in-transcript render of `/usage`.
 *
 * It answers two questions that are NOT the same question, and keeps them
 * visually apart because conflating them is how a usage read-out starts lying:
 *
 *  1. **Plan limits** — the provider's own accounting of the 5-hour and weekly
 *     windows, including the per-model weekly tiers and the pay-as-you-go
 *     meter. Rendered with the same `MeterRow` the Subscription tab and the
 *     status-bar popover use, so one window can never show two numbers.
 *  2. **Local spend** — what this install recorded, broken down by scope
 *     (session / today / 7 days), by producing surface and by model. This
 *     explains where the quota went; it is not the provider's ledger, and
 *     turns billed to an API key or run on another machine never appear in it.
 *
 * Every control is backed by data already in the block: the card is a frozen
 * transcript snapshot, so switching scope or axis re-reads a precomputed array
 * rather than a database that has moved on since the command ran. Nothing here
 * can present a control that has nothing behind it.
 *
 * Density follows the user's global usage-display preference (Appearance →
 * usage display), the same setting the Usage tab and the composer read-out
 * honour.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  ClockIcon,
  GaugeIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { MeterRow } from "@/components/settings/subscription/limits-meters-card"
import { UsageRow } from "@/components/chat/context-usage-indicator"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { fallbackPercentWhole } from "@/lib/subscription/anthropic/usage-analytics"
import {
  USAGE_SCOPE_KEYS,
  shareOfCost,
  shareOfTokens,
  type UsageNote,
  type UsageScopeKey,
  type UsageScopeReport,
  type UsageSpendTotals,
} from "@/lib/usage/usage-report"
import { formatBucketCost } from "@/lib/usage/session-analytics"
import { surfaceLabelKey } from "@/lib/usage/usage-surface-labels"
import { UsageAttributionRow } from "@/components/usage/usage-attribution-row"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { formatDuration, formatTokens } from "@/types/system/usage"
import type { UsageDiagnosticsBlock, UsageWindowStat } from "@/lib/slash-commands/system-blocks"
import type { LimitsMeter, UsageStatus } from "@/types/subscription"
import type { UsageDisplayMode } from "@/types/appearance"

/**
 * The wash both diagnostics cards sit on, inline rather than as a
 * `[--surface-bg:…]` class.
 *
 * `[data-surface-layer="raised"] { --surface-bg: … }` in globals.css is
 * UNLAYERED, and Tailwind's arbitrary-property utilities live in
 * `@layer utilities`. An unlayered declaration beats every layered one whatever
 * its specificity, so the class form silently loses and the card paints the
 * opaque tier value instead of this muted wash. An inline style is in no layer
 * at all, so it wins — the same seam `SELECTION_GLASS_TINT` uses.
 *
 * It lives here rather than in `diagnostics-card.tsx` only because that is the
 * direction the import already runs: that file renders this one. One shared
 * constant beats two that have to stay in step.
 */
export const DIAGNOSTICS_TINT = {
  "--surface-bg": "color-mix(in oklch, var(--muted) 30%, transparent)",
} as React.CSSProperties

/** Em dash for "we do not know", never for a measured zero. */
const UNKNOWN = "—"

/** Which attribution axis the list is grouped by. Both are always populated. */
type AttributionAxis = "surface" | "model"

const STATUS_ICON: Record<UsageStatus, { icon: typeof ClockIcon; className: string }> = {
  allowed: { icon: CheckCircle2Icon, className: "text-emerald-500" },
  allowed_warning: { icon: AlertTriangleIcon, className: "text-amber-500" },
  rate_limited: { icon: BanIcon, className: "text-destructive" },
  unknown: { icon: ClockIcon, className: "text-muted-foreground" },
}

/** How many attribution rows each density shows before collapsing the tail. */
const ATTRIBUTION_LIMIT: Record<UsageDisplayMode, number> = {
  simplified: 3,
  standard: 5,
  detailed: Number.POSITIVE_INFINITY,
}

/**
 * Project a v1 block's two header windows onto the meter shape the card renders.
 * Blocks recorded before `meters` existed are still in transcripts and must keep
 * working; they simply carry less (no per-model weekly tiers, no reset instant —
 * only a countdown relative to when the command ran).
 */
export function legacyWindowsToMeters(
  windows: readonly UsageWindowStat[],
  generatedAt: number
): LimitsMeter[] {
  const meters: LimitsMeter[] = []
  for (const w of windows) {
    if (w.utilization == null || w.level == null) continue
    meters.push({
      id: w.key === "fiveHour" ? "session" : "weekly",
      labelKey:
        w.key === "fiveHour"
          ? "subscription.limits.meter.session"
          : "subscription.limits.meter.weekly",
      kind: "window",
      usedPct: Math.round(w.utilization),
      resetAt: w.msUntilReset == null ? null : generatedAt + w.msUntilReset,
      status: w.level,
    })
  }
  return meters
}

/** Percent string for a 0–1 share, or the em dash when the share is unknown. */
function formatShare(share: number | null): string {
  return share == null ? UNKNOWN : `${Math.round(share * 100)}%`
}

export function UsageDiagnosticsCard({ block }: { block: UsageDiagnosticsBlock }) {
  const t = useTranslations("chat.diagnostics")
  // Root translator: meter and surface labels arrive as absolute `labelKey`s.
  const tr = useTranslations()
  const { mode } = useUsageDisplayMode()
  const { reduce } = useFlowMotion()
  // A cold shared ticker now seeds itself on first read, but a mocked or
  // server-rendered one can still hand back 0, and a countdown resolved against
  // epoch 0 renders as a 1970 date rather than as an obvious blank. Falling back
  // to the wall clock keeps this card honest whatever the ticker returns.
  const ticked = useSubscriptionNow()
  const [mountedAt] = useState(() => (ticked > 0 ? ticked : Date.now()))
  const now = ticked > 0 ? ticked : mountedAt

  // A v1 block stored a countdown, not an instant, and never recorded when the
  // command ran — so the only origin left is the moment this card mounted.
  // Frozen (not re-read each tick) because that is what lets the countdown
  // actually age: rebasing it every tick would pin it at its original value.
  const legacyOrigin = block.generatedAt ?? block.fetchedAt ?? mountedAt

  const meters = useMemo(() => {
    if (block.meters && block.meters.length > 0) return block.meters
    if (block.windows && block.windows.length > 0) {
      return legacyWindowsToMeters(block.windows, legacyOrigin)
    }
    return []
  }, [block.meters, block.windows, legacyOrigin])

  const extras = block.extras ?? []
  const availableScopes = useMemo(
    () => (block.scopes ?? []).filter((s) => s.key !== "session" || block.hasSession),
    [block.scopes, block.hasSession]
  )

  const [scopeKey, setScopeKey] = useState<UsageScopeKey>(
    () => availableScopes.find((s) => s.totals.turns > 0)?.key ?? availableScopes[0]?.key ?? "today"
  )
  const [axis, setAxis] = useState<AttributionAxis>("surface")

  const scope = availableScopes.find((s) => s.key === scopeKey) ?? availableScopes[0] ?? null

  const summary = useMemo(
    () => buildPlainSummary({ block, meters, scope, t, tr }),
    [block, meters, scope, t, tr]
  )

  const handleCopy = async () => {
    try {
      await writeClipboardText(summary)
      toast.success(t("copySuccess"))
    } catch (err) {
      toast.error(t("copyFailed", { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const statusMeta = STATUS_ICON[block.status ?? "unknown"]
  const StatusIcon = statusMeta.icon

  return (
    <Surface
      layer="raised"
      radius="stage"
      data-testid="diagnostics-card"
      data-usage-card="true"
      style={DIAGNOSTICS_TINT}
      className="@container not-prose my-1 w-full max-w-lg space-y-3 border p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <GaugeIcon className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{t("usageTitle")}</p>
            <SourceLine block={block} now={now} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {block.status ? (
            <span
              className={cn("flex items-center gap-1 text-[11px]", statusMeta.className)}
              data-testid="usage-status"
              data-status={block.status}
            >
              <StatusIcon className="size-3.5" aria-hidden />
              {t(`status.${block.status}`)}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void handleCopy()}
            aria-label={t("copy")}
            data-testid="usage-copy"
          >
            <ClipboardCopyIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      </header>

      <PlanLimitsSection
        meters={meters}
        extras={extras}
        now={now}
        fallbackPercentage={block.fallbackPercentage}
        overageDisabledReason={block.overageDisabledReason}
        representativeClaim={mode === "detailed" ? block.representativeClaim : null}
      />

      {availableScopes.length > 0 && scope ? (
        <>
          <ScopeTabs
            scopes={availableScopes}
            active={scope.key}
            onSelect={setScopeKey}
            hasSession={!!block.hasSession}
            capturedAt={block.generatedAt ?? null}
            now={now}
          />
          <SpendSummary totals={scope.totals} mode={mode} reduce={reduce} />
          <AttributionSection
            scope={scope}
            axis={axis}
            onAxisChange={setAxis}
            mode={mode}
            reduce={reduce}
          />
          {mode !== "simplified" ? <ContributorList scope={scope} /> : null}
        </>
      ) : null}

      <NoteList notes={block.notes ?? []} />
      <p className="text-[11px] text-muted-foreground">{t("usageFooter")}</p>
    </Surface>
  )
}

/* ── Header source line ─────────────────────────────────────────────────── */

function SourceLine({ block, now }: { block: UsageDiagnosticsBlock; now: number }) {
  const t = useTranslations("chat.diagnostics")
  if (!block.source || block.fetchedAt == null) {
    return <p className="text-[11px] text-muted-foreground">{t("sourceNone")}</p>
  }
  const source = t(block.source === "endpoint" ? "sourceEndpoint" : "sourceHeaders")
  const ageMs = Math.max(0, now - block.fetchedAt)
  const minutes = Math.floor(ageMs / 60_000)
  const age =
    minutes < 1
      ? t("updatedJustNow")
      : minutes < 60
        ? t("updatedMinutes", { minutes })
        : t("updatedAt", { time: new Date(block.fetchedAt).toLocaleString() })
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="usage-source">
      {source} · {age}
    </p>
  )
}

/* ── Plan limits ────────────────────────────────────────────────────────── */

function PlanLimitsSection({
  meters,
  extras,
  now,
  fallbackPercentage,
  overageDisabledReason,
  representativeClaim,
}: {
  meters: LimitsMeter[]
  extras: LimitsMeter[]
  now: number
  fallbackPercentage: number | null
  overageDisabledReason: string | null
  representativeClaim: UsageDiagnosticsBlock["representativeClaim"]
}) {
  const t = useTranslations("chat.diagnostics")
  return (
    <section className="space-y-2" data-testid="usage-plan-limits">
      <SectionLabel>{t("planLimits")}</SectionLabel>
      {meters.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-no-windows">
          {t("noWindows")}
        </p>
      ) : (
        <div className="space-y-2.5">
          {meters.map((m) => (
            <MeterRow key={m.id} meter={m} accountId="usage" now={now} />
          ))}
        </div>
      )}
      {extras.length > 0 ? (
        <div className="space-y-2.5 border-t pt-2" data-testid="usage-extras">
          {extras.map((m) => (
            <MeterRow key={m.id} meter={m} accountId="usage-extra" now={now} />
          ))}
        </div>
      ) : null}
      {representativeClaim ? (
        <UsageRow
          label={t("representative")}
          slot={t(`representativeClaim.${representativeClaim}`)}
        />
      ) : null}
      {fallbackPercentage != null ? (
        <UsageRow label={t("fallback")} slot={`${fallbackPercentWhole(fallbackPercentage)}%`} />
      ) : null}
      {overageDisabledReason ? (
        <UsageRow label={t("overageDisabled")} slot={overageDisabledReason} />
      ) : null}
    </section>
  )
}

/* ── Scope tabs ─────────────────────────────────────────────────────────── */

/** Past this, "Today" no longer means the reader's today. */
const CAPTURE_STALE_MS = 60 * 60 * 1000

function ScopeTabs({
  scopes,
  active,
  onSelect,
  hasSession,
  capturedAt,
  now,
}: {
  scopes: UsageScopeReport[]
  active: UsageScopeKey
  onSelect: (key: UsageScopeKey) => void
  hasSession: boolean
  /** When the command ran — the origin every scope label is relative to. */
  capturedAt: number | null
  now: number
}) {
  const t = useTranslations("chat.diagnostics")
  const ordered = USAGE_SCOPE_KEYS.filter(
    (k) => scopes.some((s) => s.key === k) && (k !== "session" || hasSession)
  )
  // The scopes were frozen when the command ran. Read back an hour later —
  // let alone tomorrow — "Today" and "Last 7 days" silently mean a window the
  // reader is no longer in, so the card says which day it is talking about.
  const captured =
    capturedAt != null && now - capturedAt > CAPTURE_STALE_MS
      ? new Date(capturedAt).toLocaleString()
      : null
  return (
    <div className="space-y-1 border-t pt-2">
      <div
        className="flex flex-wrap items-center gap-1"
        role="tablist"
        aria-label={t("scopeLabel")}
        data-testid="usage-scope-tabs"
      >
        {ordered.map((key) => (
          <Button
            key={key}
            variant={key === active ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-2 text-[11px]"
            role="tab"
            aria-selected={key === active}
            onClick={() => onSelect(key)}
            data-testid={`usage-scope-${key}`}
          >
            {t(`scope.${key}`)}
          </Button>
        ))}
      </div>
      {captured ? (
        <p className="text-[10px] text-muted-foreground" data-testid="usage-captured-at">
          {t("capturedAt", { time: captured })}
        </p>
      ) : null}
    </div>
  )
}

/* ── Spend summary ──────────────────────────────────────────────────────── */

function SpendSummary({
  totals,
  mode,
  reduce,
}: {
  totals: UsageSpendTotals
  mode: UsageDisplayMode
  reduce: boolean
}) {
  const t = useTranslations("chat.diagnostics")
  const animatedCost = useCountUp(totals.costUsd, { disabled: reduce, durationMs: 500 })

  if (totals.turns === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="usage-scope-empty">
        {t("scopeEmpty")}
      </p>
    )
  }

  const cost = formatBucketCost(animatedCost, totals.unpricedTurns, totals.turns)
  return (
    <section className="space-y-1.5" data-testid="usage-spend">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 @xs:grid-cols-3 @md:grid-cols-4">
        <StatTile label={t("cost")} value={cost} testid="usage-stat-cost" />
        <StatTile
          label={t("active")}
          value={totals.durationMs > 0 ? formatDuration(totals.durationMs) : UNKNOWN}
          testid="usage-stat-active"
        />
        <StatTile label={t("turns")} value={String(totals.turns)} testid="usage-stat-turns" />
        <StatTile
          label={t("cacheHit")}
          value={formatShare(totals.cacheHitRate)}
          testid="usage-stat-cache"
        />
        {totals.sessions > 1 ? (
          <StatTile
            label={t("sessions")}
            value={String(totals.sessions)}
            testid="usage-stat-sessions"
          />
        ) : null}
        {mode === "detailed" && totals.reasoningTokens > 0 ? (
          <StatTile
            label={t("reasoning")}
            value={formatTokens(totals.reasoningTokens)}
            testid="usage-stat-reasoning"
          />
        ) : null}
      </div>
      {mode !== "simplified" ? (
        <div className="space-y-1 border-t pt-1.5">
          <UsageRow label={t("inputTokensRaw")} slot={formatTokens(totals.inputTokens)} />
          <UsageRow label={t("outputTokens")} slot={formatTokens(totals.outputTokens)} />
          <UsageRow
            label={t("cache")}
            slot={t("cacheValue", {
              write: formatTokens(totals.cacheCreationTokens),
              read: formatTokens(totals.cacheReadTokens),
            })}
          />
        </div>
      ) : null}
      {totals.unpricedTurns > 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="usage-unpriced">
          {t("unpricedTurns", { turns: totals.unpricedTurns })}
        </p>
      ) : null}
    </section>
  )
}

function StatTile({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="min-w-0" data-testid={testid}>
      <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-sm tabular-nums">{value}</p>
    </div>
  )
}

/* ── Attribution ────────────────────────────────────────────────────────── */

function AttributionSection({
  scope,
  axis,
  onAxisChange,
  mode,
  reduce,
}: {
  scope: UsageScopeReport
  axis: AttributionAxis
  onAxisChange: (axis: AttributionAxis) => void
  mode: UsageDisplayMode
  reduce: boolean
}) {
  const t = useTranslations("chat.diagnostics")
  const tr = useTranslations()

  const rows = useMemo(() => {
    const limit = ATTRIBUTION_LIMIT[mode]
    const source =
      axis === "surface"
        ? scope.surfaces.map((s) => ({
            id: s.surface,
            labelKey: `subscription.usage.surface.${surfaceLabelKey(s.surface)}`,
            bucket: s,
          }))
        : scope.models.map((m) => ({ id: m.model, labelKey: null, bucket: m }))
    return source.slice(0, Number.isFinite(limit) ? limit : source.length)
  }, [axis, scope, mode])

  const hidden = (axis === "surface" ? scope.surfaces.length : scope.models.length) - rows.length

  if (scope.totals.turns === 0) return null

  return (
    <section className="space-y-2 border-t pt-2" data-testid="usage-attribution">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{t("attributionTitle")}</SectionLabel>
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label={t("axisLabel")}
          data-testid="usage-axis-tabs"
        >
          {(["surface", "model"] as const).map((key) => (
            <Button
              key={key}
              variant={key === axis ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px]"
              role="tab"
              aria-selected={key === axis}
              onClick={() => onAxisChange(key)}
              data-testid={`usage-axis-${key}`}
            >
              {t(`axis.${key}`)}
            </Button>
          ))}
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => {
          // Surface rows resolve through the catalogue; model rows are raw ids
          // the provider chose and are shown verbatim.
          const label = row.labelKey && tr.has(row.labelKey) ? tr(row.labelKey) : row.id
          return (
            <AttributionRow
              key={`${axis}:${row.id}`}
              id={row.id}
              label={label}
              bucket={row.bucket}
              totals={scope.totals}
              mode={mode}
              reduce={reduce}
            />
          )
        })}
      </ul>
      {hidden > 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="usage-attribution-more">
          {t("attributionMore", { count: hidden })}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Share + money for one bucket. The markup lives in `UsageAttributionRow`,
 * shared with the Usage dashboard. What stays here is the transcript card's own
 * policy: rank by cost where cost is known and fall back to tokens where it is
 * not, and only spell out the turn/token detail line in detailed mode.
 */
function AttributionRow({
  id,
  label,
  bucket,
  totals,
  mode,
  reduce,
}: {
  id: string
  label: string
  bucket: {
    turns: number
    costUsd: number
    unpricedTurns: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
  totals: UsageSpendTotals
  mode: UsageDisplayMode
  reduce: boolean
}) {
  const t = useTranslations("chat.diagnostics")
  // Share by cost where cost is known, else by tokens. A free/local model can
  // dominate the plan's token budget while contributing $0, and ranking it at
  // "0%" would hide exactly the thing the user is looking for.
  const share = shareOfCost(bucket, totals) ?? shareOfTokens(bucket, totals)

  return (
    <UsageAttributionRow
      id={id}
      label={label}
      pct={share == null ? null : Math.round(share * 100)}
      costUsd={bucket.costUsd}
      unpricedTurns={bucket.unpricedTurns}
      turns={bucket.turns}
      reduce={reduce}
      detail={
        mode === "detailed"
          ? t("bucketDetail", {
              turns: bucket.turns,
              tokens: formatTokens(
                bucket.inputTokens +
                  bucket.outputTokens +
                  bucket.cacheReadTokens +
                  bucket.cacheCreationTokens
              ),
            })
          : undefined
      }
    />
  )
}

/* ── Contributors ───────────────────────────────────────────────────────── */

function ContributorList({ scope }: { scope: UsageScopeReport }) {
  const t = useTranslations("subscription.usage.insights")
  if (scope.totals.turns === 0 || scope.contributors.length === 0) return null
  return (
    <section className="space-y-1.5 border-t pt-2" data-testid="usage-contributors">
      <SectionLabel>{t("title")}</SectionLabel>
      <ul className="space-y-1">
        {scope.contributors.map((c) => (
          <li
            key={c.id}
            className="flex gap-2 text-xs text-muted-foreground"
            data-testid={`usage-contributor-${c.id}`}
          >
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
            <span>
              {t(`${c.id === "high-context" ? "highContext" : "automatedSurface"}.headline`, {
                pct: c.pct,
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ── Notes ──────────────────────────────────────────────────────────────── */

function NoteList({ notes }: { notes: readonly UsageNote[] }) {
  const t = useTranslations("chat.diagnostics")
  if (notes.length === 0) return null
  return (
    <ul className="space-y-1 border-t pt-2" data-testid="usage-notes">
      {notes.map((note, index) => (
        <li
          key={`${note.id}:${index}`}
          className="text-[11px] text-muted-foreground"
          data-testid={`usage-note-${note.id}`}
        >
          {note.detail
            ? t(`note.${camelNoteId(note.id)}Detail`, { detail: note.detail })
            : t(`note.${camelNoteId(note.id)}`)}
        </li>
      ))}
    </ul>
  )
}

/** `quota-error` → `quotaError`; the note ids are kebab-case, i18n leaves are not. */
function camelNoteId(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  )
}

/* ── Clipboard projection ───────────────────────────────────────────────── */

/** Minimal shape of a next-intl translator, so the projection stays testable. */
type Translate = (key: string, values?: Record<string, string | number>) => string

interface PlainSummaryInput {
  block: UsageDiagnosticsBlock
  meters: LimitsMeter[]
  scope: UsageScopeReport | null
  /** Namespaced to `chat.diagnostics`. */
  t: Translate
  /** Root translator, for the `labelKey`s meters and surfaces carry. */
  tr: Translate & { has: (key: string) => boolean }
}

/**
 * The exact figures on screen as portable text. Copying a usage read-out is how
 * people paste it into a bug report, so it must carry the same numbers the card
 * shows — including the "not priced" caveats, which are the part a reader is
 * most likely to be misled without.
 */
export function buildPlainSummary({ block, meters, scope, t, tr }: PlainSummaryInput): string {
  const label = (labelKey: string | undefined, fallback: string): string =>
    labelKey && tr.has(labelKey) ? tr(labelKey) : fallback
  const lines: string[] = [t("usageTitle")]
  if (block.fetchedAt != null && block.source) {
    lines.push(
      `${t(block.source === "endpoint" ? "sourceEndpoint" : "sourceHeaders")} · ${new Date(
        block.fetchedAt
      ).toLocaleString()}`
    )
  }
  lines.push("")
  lines.push(`${t("planLimits")}:`)
  if (meters.length === 0) {
    lines.push(`  ${t("noWindows")}`)
  } else {
    for (const m of meters) {
      const pct = m.usedPct == null ? UNKNOWN : `${Math.round(m.usedPct)}%`
      const reset = m.resetAt != null ? ` (${new Date(m.resetAt).toLocaleString()})` : ""
      lines.push(`  ${label(m.labelKey, m.label ?? m.id)}: ${pct}${reset}`)
    }
  }
  for (const m of block.extras ?? []) {
    lines.push(`  ${label(m.labelKey, m.label ?? m.id)}: ${m.remaining ?? m.usedPct ?? UNKNOWN}`)
  }
  if (scope && scope.totals.turns > 0) {
    lines.push("")
    lines.push(`${t(`scope.${scope.key}`)}:`)
    lines.push(
      `  ${t("cost")} ${formatBucketCost(scope.totals.costUsd, scope.totals.unpricedTurns, scope.totals.turns)}` +
        ` · ${t("turns")} ${scope.totals.turns}` +
        ` · ${t("cacheHit")} ${formatShare(scope.totals.cacheHitRate)}`
    )
    for (const s of scope.surfaces) {
      const surfaceLabel = label(
        `subscription.usage.surface.${surfaceLabelKey(s.surface)}`,
        s.surface
      )
      lines.push(
        `  ${surfaceLabel}: ${formatBucketCost(s.costUsd, s.unpricedTurns, s.turns)} (${s.turns})`
      )
    }
    for (const m of scope.models) {
      lines.push(
        `  ${m.model}: ${formatBucketCost(m.costUsd, m.unpricedTurns, m.turns)} (${m.turns})`
      )
    }
  }
  for (const note of block.notes ?? []) {
    lines.push(
      note.detail
        ? t(`note.${camelNoteId(note.id)}Detail`, { detail: note.detail })
        : t(`note.${camelNoteId(note.id)}`)
    )
  }
  return lines.join("\n")
}
