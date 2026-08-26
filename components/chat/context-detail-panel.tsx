"use client"

/**
 * Collapsible "what is in the window" panel for the context popover.
 *
 * Renders the one normalised {@link ContextBreakdown} model — so the
 * SDK-authoritative snapshot and the transcript estimate get the exact same
 * layout, and the badge says which one you are looking at instead of leaving
 * the reader to guess.
 *
 * Fully controlled: the popover it lives in is a hover card whose content
 * unmounts on close, so both the section's open state and the per-group
 * expansion live in the owner (`ContextUsageIndicator`) and survive re-opening.
 */

import { ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { ContextBreakdown, ContextGroup, ContextGroupId } from "@/lib/claude/context-breakdown"

/** Longest item list rendered inline — beyond this the tail is summarised. */
const MAX_ITEMS = 8

const compact = new Intl.NumberFormat("en-US", { notation: "compact" })
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" })

/**
 * Group → translation key. Dynamic `t()` keys are invisible to `lint:i18n`, so
 * this table is pinned by a catalogue-coverage test next door.
 */
export const GROUP_LABEL_KEY: Record<Exclude<ContextGroupId, "other">, string> = {
  messages: "breakdownMessages",
  systemPrompt: "breakdownSystemPrompt",
  systemTools: "breakdownTools",
  mcp: "breakdownMcp",
  memory: "breakdownMemory",
  agents: "breakdownAgents",
  commands: "breakdownCommands",
  skills: "breakdownSkills",
  userMessages: "breakdownUserMessages",
  mentionedFiles: "breakdownMentionedFiles",
  toolOutputs: "breakdownToolOutputs",
  thinking: "breakdownThinking",
  taskCoordination: "breakdownTaskCoordination",
  free: "breakdownFree",
}

/**
 * Legend colour per group. Theme chart tokens only — the palette has to hold up
 * in both light and dark, which hard-coded Tailwind hues do not.
 */
const GROUP_COLOR: Record<ContextGroupId, string> = {
  messages: "bg-chart-1",
  systemPrompt: "bg-chart-2",
  systemTools: "bg-chart-3",
  mcp: "bg-chart-4",
  memory: "bg-chart-5",
  agents: "bg-chart-1/60",
  commands: "bg-chart-2/60",
  skills: "bg-chart-3/60",
  userMessages: "bg-chart-1",
  mentionedFiles: "bg-chart-2",
  toolOutputs: "bg-chart-3",
  thinking: "bg-chart-4",
  taskCoordination: "bg-chart-5",
  other: "bg-muted-foreground/40",
  free: "bg-muted-foreground/20",
}

/** Sub-percent slices still deserve a number rather than a rounded-away "0%". */
function formatShare(fraction: number): string {
  if (fraction > 0 && fraction < 0.001) return `<${percent.format(0.001)}`
  return percent.format(fraction)
}

export interface ContextDetailPanelProps {
  breakdown: ContextBreakdown
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Keys of the groups whose item list is expanded. */
  expanded: string[]
  onExpandedChange: (next: string[]) => void
  className?: string
}

export function ContextDetailPanel({
  breakdown,
  open,
  onOpenChange,
  expanded,
  onExpandedChange,
  className,
}: ContextDetailPanelProps) {
  const t = useTranslations("chat.composer.toolbar")
  const rows = breakdown.free ? [...breakdown.groups, breakdown.free] : breakdown.groups
  if (rows.length === 0) return null

  const toggle = (key: string) =>
    onExpandedChange(
      expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]
    )

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn("mt-2 border-t pt-2", className)}
      data-testid="context-detail-panel"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-sm py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
        />
        <span className="font-medium">{t("detailsToggle")}</span>
        <span
          className="ml-auto rounded-sm bg-muted px-1 py-px font-mono text-[9px] uppercase tracking-wide"
          data-testid="context-detail-source"
        >
          {breakdown.source === "live" ? t("detailsLive") : t("detailsEstimated")}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="pt-2">
        <SegmentBar groups={breakdown.groups} />
        {breakdown.denominator === "attributed" ? (
          <p
            className="mt-1 text-[10px] text-muted-foreground/80"
            data-testid="context-detail-note"
          >
            {t("detailsOfTranscript")}
          </p>
        ) : null}
        <div className="mt-2 space-y-px">
          {rows.map((group) => (
            <GroupRow
              key={group.key}
              group={group}
              expanded={expanded.includes(group.key)}
              onToggle={() => toggle(group.key)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Stacked share bar. The muted track is the free remainder — no slice needed.
 * Deferred groups are listed but never drawn: they describe tools that are
 * declared and *not* loaded, so painting them would push the bar past 100% and
 * contradict the occupancy percentage in the header.
 */
export function SegmentBar({ groups }: { groups: ContextGroup[] }) {
  return (
    <div
      className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
      data-testid="context-segment-bar"
      aria-hidden
    >
      {groups
        .filter((group) => !group.deferred)
        .map((group) => (
          <div
            key={group.key}
            className={cn(GROUP_COLOR[group.id])}
            style={{ width: `${Math.max(group.fraction * 100, 0.5)}%` }}
            data-group={group.key}
          />
        ))}
    </div>
  )
}

function GroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: ContextGroup
  expanded: boolean
  onToggle: () => void
}) {
  const t = useTranslations("chat.composer.toolbar")
  const expandable = group.items.length > 0
  const base = group.id === "other" ? (group.rawName ?? "") : t(GROUP_LABEL_KEY[group.id])
  const label = group.deferred ? t("breakdownDeferred", { label: base }) : base
  const hidden = Math.max(0, group.items.length - MAX_ITEMS)

  return (
    <div data-testid={`context-group-${group.key}`}>
      <button
        type="button"
        disabled={!expandable}
        onClick={onToggle}
        aria-expanded={expandable ? expanded : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-sm px-1 py-[3px] text-left text-[11px]",
          expandable ? "hover:bg-muted/70" : "cursor-default"
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-2.5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-90",
            !expandable && "invisible"
          )}
        />
        <span
          className={cn(
            "size-2 shrink-0 rounded-[3px]",
            GROUP_COLOR[group.id],
            group.deferred && "opacity-40"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
        {group.itemCount > 0 ? (
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground/60"
            aria-label={t("breakdownItemsAria", { count: group.itemCount })}
          >
            {group.itemCount}
          </span>
        ) : null}
        <span className="w-11 shrink-0 text-right font-mono tabular-nums">
          {compact.format(group.tokens)}
        </span>
        <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatShare(group.fraction)}
        </span>
      </button>

      {expandable && expanded ? (
        <ul
          className="ml-[13px] space-y-px border-l pl-2 pt-px"
          data-testid={`context-items-${group.key}`}
        >
          {group.items.slice(0, MAX_ITEMS).map((item) => (
            <li
              key={`${item.label}:${item.hint ?? ""}`}
              className="flex items-center gap-2 py-px text-[10px] text-muted-foreground"
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={item.hint ? `${item.hint} · ${item.label}` : item.label}
              >
                {item.label}
                {item.hint ? (
                  <span className="ml-1 text-muted-foreground/60">{item.hint}</span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono tabular-nums">{compact.format(item.tokens)}</span>
            </li>
          ))}
          {hidden > 0 ? (
            <li className="py-px text-[10px] text-muted-foreground/70">
              {t("breakdownMoreItems", { count: hidden })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

export default ContextDetailPanel
