"use client"

/**
 * The external agent's capability profile, rendered.
 *
 * One table, driven by `ExternalAgentCapabilityProfileV1` (ADR-0090 external
 * SSOT) — the same artifact the CLI's `--backend` selection, the TUI's feature
 * rows and the execution resolver read. Before this, the desktop had no
 * capability view at all: a user whose `/compact` did nothing, or whose MCP
 * servers never reached the agent, had nowhere to look.
 *
 * Three things it deliberately shows that a boolean list cannot:
 *   - `unknown` as its own state. "Nobody has measured this" is not the same
 *     claim as "this does not work", and collapsing them is what let a stale
 *     table pass for knowledge.
 *   - the EVIDENCE behind each verdict, so "the protocol spec says so" is
 *     distinguishable from "this session's handshake said so".
 *   - drift — a live fact that contradicted a checked-in manifest row, which
 *     means the row needs updating and not that the session is broken.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import {
  EXTERNAL_AGENT_CAPABILITY_IDS,
  type ExternalAgentCapabilityCell,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityProfileV1,
} from "@cognia/agent-config-types/external-agent-capability"
import { cn } from "@/lib/utils"

type CapabilityLevel = ExternalAgentCapabilityCell["level"]

/** Filter chip order: what the agent can do first, refusals last. */
const LEVEL_ORDER: readonly CapabilityLevel[] = ["native", "equivalent", "unknown", "unsupported"]

const LEVEL_CLASS: Record<CapabilityLevel, string> = {
  native: "text-emerald-700 dark:text-emerald-400",
  equivalent: "text-sky-700 dark:text-sky-400",
  unknown: "text-amber-700 dark:text-amber-400",
  unsupported: "text-muted-foreground",
}

const LEVEL_DOT: Record<CapabilityLevel, string> = {
  native: "bg-emerald-500",
  equivalent: "bg-sky-500",
  unknown: "bg-amber-500",
  unsupported: "bg-muted-foreground/40",
}

/**
 * The sentence behind a cell's `reasonKey`.
 *
 * Two catalogues, because the keys come from two shapes. Most are flat names
 * (`noProtocolSlot`, `notNegotiated`) and live under `reason.`. The
 * adapter-methods layer stamps a DOTTED key — `adapterMethod.steerTurn` — and
 * next-intl reads a dot as nesting, so `reason.adapterMethod.steerTurn` finds
 * nothing: those sentences were authored one level up, under
 * `capabilities.adapterMethod.*`. Looking only under `reason.` printed the raw
 * identifier to the user in both locales while the translations sat unreachable.
 */
function reasonText(t: ReturnType<typeof useTranslations>, reasonKey: string): string {
  if (t.has(`reason.${reasonKey}`)) return t(`reason.${reasonKey}`)
  if (t.has(reasonKey)) return t(reasonKey)
  return reasonKey
}

export interface ExternalAgentCapabilityMatrixProps {
  profile: ExternalAgentCapabilityProfileV1 | null | undefined
  /** Hide `unsupported` rows, which are the majority for most protocols. */
  onlyAvailable?: boolean
  className?: string
}

export function ExternalAgentCapabilityMatrix({
  profile,
  onlyAvailable = false,
  className,
}: ExternalAgentCapabilityMatrixProps) {
  const t = useTranslations("externalAgent.capabilities")
  // One level at a time, or every row. Thirty-odd rows of equal weight read as
  // a dump; a count per level answers "what can it do" before any row does.
  const [levelFilter, setLevelFilter] = useState<CapabilityLevel | null>(null)

  const rows = useMemo(() => {
    if (!profile) return []
    return EXTERNAL_AGENT_CAPABILITY_IDS.map((id: ExternalAgentCapabilityId) => ({
      id,
      cell: profile.effective[id],
    })).filter(({ cell }) => !onlyAvailable || cell.level !== "unsupported")
  }, [profile, onlyAvailable])

  const counts = useMemo(() => {
    const byLevel = new Map<CapabilityLevel, number>()
    for (const { cell } of rows) byLevel.set(cell.level, (byLevel.get(cell.level) ?? 0) + 1)
    return LEVEL_ORDER.flatMap((level) => {
      const count = byLevel.get(level)
      return count ? [{ level, count }] : []
    })
  }, [rows])

  if (!profile) {
    // Not an error state: a profile only exists after the handshake, and saying
    // "no capabilities" here would be a claim nobody has earned.
    return <p className="text-xs text-muted-foreground">{t("notNegotiated")}</p>
  }

  const visible = levelFilter ? rows.filter(({ cell }) => cell.level === levelFilter) : rows

  return (
    <div className={cn("grid gap-3 text-xs", className)} data-testid="external-agent-capabilities">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("protocol", { protocol: profile.protocol })}</span>
        <span className="text-muted-foreground">·</span>
        <span className={profile.negotiated ? "text-foreground" : "text-muted-foreground"}>
          {profile.negotiated ? t("negotiated") : t("declaredOnly")}
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {t("digest", { digest: profile.digest.slice(0, 14) })}
        </span>
      </div>

      {profile.drift.length > 0 && (
        <p
          className="border-l-2 border-amber-500/70 py-0.5 pl-3 text-amber-700 dark:text-amber-400"
          data-testid="external-agent-capability-drift"
        >
          {t("drift", {
            entries: profile.drift
              .map((entry) =>
                t("driftEntry", {
                  capability: entry.capability,
                  declared: entry.declaredLevel,
                  observed: entry.observedLevel,
                })
              )
              .join(" | "),
          })}
        </p>
      )}

      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={t("filterLabel")}
        data-testid="capability-filters"
      >
        <FilterChip active={levelFilter === null} onClick={() => setLevelFilter(null)}>
          {t("filterAll")}
          <span className="font-medium tabular-nums">{rows.length}</span>
        </FilterChip>
        {counts.map(({ level, count }) => (
          <FilterChip
            key={level}
            active={levelFilter === level}
            className={levelFilter === level ? undefined : LEVEL_CLASS[level]}
            onClick={() => setLevelFilter(levelFilter === level ? null : level)}
          >
            {t(`level.${level}`)}
            <span className="font-medium tabular-nums">{count}</span>
          </FilterChip>
        ))}
      </div>

      <ul className="grid gap-x-8 lg:grid-cols-2">
        {visible.map(({ id, cell }) => (
          <li
            key={id}
            className="flex min-w-0 items-start gap-2.5 border-b border-border/50 py-2"
            data-testid={`capability-${id}`}
          >
            <span
              className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", LEVEL_DOT[cell.level])}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={id}>
                  {id}
                </span>
                <span className={cn("shrink-0 text-[11px]", LEVEL_CLASS[cell.level])}>
                  {t(`level.${cell.level}`)}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                {t(`evidence.${cell.evidence}`)}
                {cell.reasonKey && <> · {reasonText(t, cell.reasonKey)}</>}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-pill bg-muted/60 px-2.5 text-[11px] transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        className,
        active && "bg-foreground text-background hover:bg-foreground/90"
      )}
    >
      {children}
    </button>
  )
}
