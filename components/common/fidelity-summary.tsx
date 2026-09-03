"use client"

/**
 * The shared layout for "here is what this conversion did and did not carry".
 *
 * Three surfaces render that shape: session import (`SessionLossReport`),
 * plugin conversion (`PluginConversionReport`), and the migration wizard (bare
 * warning strings). They have different fidelity vocabularies and different
 * issue types, so they keep their own adapters and their own message
 * namespaces. What they share is the arrangement, and only that lives here.
 *
 * Every string arrives already translated. That is deliberate: a component that
 * called `useTranslations` itself would force the three callers into one merged
 * namespace, and the repo's i18n rule is about where keys live, not about which
 * component reads them.
 *
 * Two constraints this must keep. `FidelityReport` renders inside the chat
 * header's `max-w-sm` tooltip (`components/chat/imported-origin-chip.tsx`), so
 * nothing here may add a Card, a background, or a fixed width. And the entry
 * list is uncapped by default, because the session report's existing behaviour
 * is to show every loss.
 */

import { Badge } from "@/components/ui/badge"

export type FidelityBadgeVariant = "default" | "secondary" | "outline" | "destructive"

export interface FidelitySummaryBadge {
  id: string
  label: string
  variant: FidelityBadgeVariant
  testId?: string
}

export interface FidelitySummaryEntry {
  id: string
  /** Already-translated kind, e.g. "Dropped" or "Approximated". */
  label: string
  /** Source path or capability name, rendered monospaced and breakable. */
  path?: string
  /** Free-text detail from the converter. */
  detail?: string
}

export interface FidelitySummaryProps {
  title: string
  badges?: readonly FidelitySummaryBadge[]
  /** One line per hint, rendered under the badge row. */
  hints?: readonly string[]
  /** Caller-owned metadata block (a `<dl>`, typically). */
  meta?: React.ReactNode
  entries: readonly FidelitySummaryEntry[]
  /** Shown instead of the list when `entries` is empty. Empty string renders nothing. */
  emptyLabel: string
  /** Optional count line above the list. */
  countLabel?: string
  /**
   * Cap the rendered entries. Opt-in: session import shows every loss, and
   * changing that would be a behaviour change disguised as a refactor.
   */
  maxEntries?: number
  /** Rendered after a truncated list. Receives the hidden count from the caller. */
  moreLabel?: (hidden: number) => string
  testId?: string
  countTestId?: string
  emptyTestId?: string
}

export function FidelitySummary({
  title,
  badges,
  hints,
  meta,
  entries,
  emptyLabel,
  countLabel,
  maxEntries,
  moreLabel,
  testId = "fidelity-summary",
  countTestId,
  emptyTestId,
}: FidelitySummaryProps) {
  const shown = maxEntries === undefined ? entries : entries.slice(0, maxEntries)
  const hidden = entries.length - shown.length

  return (
    <div className="space-y-2 text-xs" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        {badges?.map((badge) => (
          <Badge key={badge.id} variant={badge.variant} data-testid={badge.testId}>
            {badge.label}
          </Badge>
        ))}
      </div>
      {hints?.map((hint, index) => (
        <p key={`${index}-${hint}`} className="text-muted-foreground">
          {hint}
        </p>
      ))}
      {meta}
      {entries.length === 0 ? (
        // An empty label is a real choice, not an oversight: the migration
        // wizard has nothing to add beyond its status explanation.
        emptyLabel ? (
          <p className="text-muted-foreground" data-testid={emptyTestId}>
            {emptyLabel}
          </p>
        ) : null
      ) : (
        <div className="space-y-1">
          {countLabel && (
            <p className="text-muted-foreground" data-testid={countTestId}>
              {countLabel}
            </p>
          )}
          <ul className="list-disc space-y-0.5 pl-4">
            {shown.map((entry) => (
              <li key={entry.id} className="min-w-0 text-muted-foreground">
                {entry.path && <span className="font-mono break-all">{entry.path}</span>}
                {entry.path ? " \u00b7 " : ""}
                {entry.label}
                {entry.detail ? `: ${entry.detail}` : ""}
              </li>
            ))}
          </ul>
          {hidden > 0 && moreLabel && (
            <p className="text-muted-foreground" data-testid="fidelity-summary-more">
              {moreLabel(hidden)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
