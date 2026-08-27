"use client"

// Collapsible group of color tokens for the custom theme editor. The eight
// role-based clusters — surface & text, brand, status, sidebar, charts,
// workflow nodes, workflow statuses, product accent — come straight from
// `theme-token-catalog.ts` rather than being restated here, so a token added to
// the catalog cannot go missing from the editor. Pure presentation: the parent
// owns draft state, audit results, search, and i18n labels.

import { ChevronRightIcon, RotateCcwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { ResolvedThemeColors, ThemeColors } from "@/types/plugin/plugin"
import {
  DEFAULT_GROUP_OPEN,
  THEME_COLOR_KEYS,
  THEME_TOKEN_GROUPS,
  type ThemeTokenGroupKey,
} from "@/lib/appearance"
import { type ContrastAudit, isFlaggedPair } from "@/lib/appearance/contrast-audit"
import { cn } from "@/lib/utils"
import { ColorTokenRow } from "./color-token-row"

export type TokenGroupKey = ThemeTokenGroupKey

/**
 * Disjoint partition of `THEME_COLOR_KEYS` by visual role, projected from the
 * catalog. `theme-token-catalog.test.ts` asserts no token is missing and none
 * appears twice — adding a token to `ThemeColors` without giving it a catalog
 * entry fails that test, which is the intended forcing function.
 */
export const TOKEN_GROUPS: ReadonlyArray<{
  key: TokenGroupKey
  tokens: readonly (keyof ThemeColors)[]
}> = THEME_TOKEN_GROUPS

export { DEFAULT_GROUP_OPEN }

/**
 * Count audit failures touching any of the supplied keys. The same pair
 * (e.g. `foreground` × `background`) can surface in two groups — that's
 * deliberate: each group's header reflects the problems users would land
 * on while inspecting that group.
 */
export function countGroupFailures(
  audit: ContrastAudit,
  tokens: readonly (keyof ThemeColors)[]
): number {
  const set = new Set<keyof ThemeColors>(tokens)
  let n = 0
  for (const failure of audit.failures) {
    if (set.has(failure.pair[0]) || set.has(failure.pair[1])) n += 1
  }
  return n
}

export interface TokenGroupProps {
  groupKey: TokenGroupKey
  /** Localised group label (e.g., "Surface & text"). */
  label: string
  tokens: readonly (keyof ThemeColors)[]
  /** Whether the group is initially expanded. Ignored while `open` is supplied. */
  defaultOpen: boolean
  /**
   * Controlled expansion. The editor drives this while a search is active so a
   * group holding a match opens itself; left undefined the group is
   * uncontrolled and remembers its own state.
   */
  open?: boolean
  onOpenChange?: (next: boolean) => void
  /** Per-token current value (falls back to `fallback[key]`). */
  values: Partial<ThemeColors>
  /**
   * The resolved palette behind the draft. A row with no explicit value shows
   * this, so an untouched derived token displays the colour it will actually
   * paint rather than a blank.
   */
  fallback: ResolvedThemeColors
  audit: ContrastAudit
  /** Localised label resolver for a single token row. */
  tokenLabel: (key: keyof ThemeColors) => string
  /** Localised aria label for the colour swatch input. */
  swatchAriaLabel: (key: keyof ThemeColors) => string
  /** Localised aria label for the hex input. */
  hexAriaLabel: (key: keyof ThemeColors) => string
  /** Short chip text shown next to a flagged row. */
  auditChipLabel: string
  /** Header badge text when `count > 0`. */
  failureBadgeLabel: (count: number) => string
  onChange: (key: keyof ThemeColors, next: string) => void
  /** Drop a token's override so it falls back to the default / derivation. */
  onReset?: (key: keyof ThemeColors) => void
  /** Localised label for the per-row reset control. */
  resetLabel?: string
}

export function TokenGroup({
  groupKey,
  label,
  tokens,
  defaultOpen,
  open,
  onOpenChange,
  values,
  fallback,
  audit,
  tokenLabel,
  swatchAriaLabel,
  hexAriaLabel,
  auditChipLabel,
  failureBadgeLabel,
  onChange,
  onReset,
  resetLabel,
}: TokenGroupProps) {
  const failureCount = countGroupFailures(audit, tokens)
  if (tokens.length === 0) return null
  return (
    <Collapsible
      defaultOpen={open === undefined ? defaultOpen : undefined}
      open={open}
      onOpenChange={onOpenChange}
      data-token-group={groupKey}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-left",
          "transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        data-testid={`token-group-${groupKey}-trigger`}
      >
        <ChevronRightIcon
          className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span className="flex-1 text-xs font-medium uppercase tracking-wide">{label}</span>
        <span className="text-[10px] text-muted-foreground">{tokens.length}</span>
        {failureCount > 0 && (
          <Badge
            variant="destructive"
            className="text-[10px]"
            data-testid={`token-group-${groupKey}-failures`}
          >
            {failureBadgeLabel(failureCount)}
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent
        className="px-1 pt-2 pb-1"
        data-testid={`token-group-${groupKey}-content`}
      >
        {/* Container-driven: the group renders inside the Appearance section's
            ~700px detail pane, where a viewport `xl:` split would two-column
            the rows while each half is too narrow for label + swatch + hex.
            Falls back to one column wherever no named container exists. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 @3xl/appearance-pane:grid-cols-2">
          {tokens.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <ColorTokenRow
                tokenKey={key}
                label={tokenLabel(key)}
                value={values[key] ?? fallback[key]}
                onChange={(next) => onChange(key, next)}
                className="min-w-0 flex-1"
                swatchAriaLabel={swatchAriaLabel(key)}
                hexAriaLabel={hexAriaLabel(key)}
              />
              {onReset && values[key] !== undefined && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0"
                  onClick={() => onReset(key)}
                  aria-label={resetLabel ? `${resetLabel}: ${tokenLabel(key)}` : undefined}
                  title={resetLabel}
                  data-testid={`token-reset-${key}`}
                >
                  <RotateCcwIcon className="size-3" aria-hidden="true" />
                </Button>
              )}
              {isFlaggedPair(audit, key) && (
                <Badge
                  variant="destructive"
                  className="shrink-0 text-[10px]"
                  data-testid={`audit-chip-${key}`}
                >
                  {auditChipLabel}
                </Badge>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Sanity helper used by the partition test. */
export function flattenedGroupTokens(): (keyof ThemeColors)[] {
  return TOKEN_GROUPS.flatMap((g) => [...g.tokens])
}

/** Asserts that the TOKEN_GROUPS partition covers `THEME_COLOR_KEYS` exactly once. */
export function partitionInvariant(): {
  missing: (keyof ThemeColors)[]
  duplicates: (keyof ThemeColors)[]
} {
  const seen = new Map<keyof ThemeColors, number>()
  for (const k of flattenedGroupTokens()) {
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const missing = THEME_COLOR_KEYS.filter((k) => !seen.has(k))
  const duplicates: (keyof ThemeColors)[] = []
  for (const [k, count] of seen) {
    if (count > 1) duplicates.push(k)
  }
  return { missing, duplicates }
}
