"use client"

// Collapsible group of color tokens for the custom theme editor. Replaces
// the previous flat 27-row list with five role-based clusters (Surface /
// Text / Brand / State / Sidebar) so users can navigate the palette by
// purpose. Pure presentation — the parent owns draft state, audit results,
// and i18n labels.

import { ChevronRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { THEME_COLOR_KEYS } from "@/lib/appearance"
import { type ContrastAudit, isFlaggedPair } from "@/lib/appearance/contrast-audit"
import { cn } from "@/lib/utils"
import { ColorTokenRow } from "./color-token-row"

export type TokenGroupKey = "surface" | "text" | "brand" | "state" | "sidebar"

// Disjoint partition of `THEME_COLOR_KEYS` by visual role. The
// `token-group.test.tsx` partition test asserts no token is missing and
// none appears twice — adding a new token to `ThemeColors` will fail that
// test until it's placed in a group, which is the intended forcing function.
export const TOKEN_GROUPS: ReadonlyArray<{
  key: TokenGroupKey
  tokens: readonly (keyof ThemeColors)[]
}> = [
  {
    key: "surface",
    tokens: ["background", "card", "popover", "muted"],
  },
  {
    key: "text",
    tokens: [
      "foreground",
      "cardForeground",
      "popoverForeground",
      "mutedForeground",
      "secondaryForeground",
      "accentForeground",
      "primaryForeground",
      "destructiveForeground",
      "sidebarForeground",
      "sidebarPrimaryForeground",
      "sidebarAccentForeground",
    ],
  },
  {
    key: "brand",
    tokens: ["primary", "secondary", "accent"],
  },
  {
    key: "state",
    tokens: ["destructive", "border", "input", "ring"],
  },
  {
    key: "sidebar",
    tokens: ["sidebar", "sidebarPrimary", "sidebarAccent", "sidebarBorder", "sidebarRing"],
  },
]

export const DEFAULT_GROUP_OPEN: Record<TokenGroupKey, boolean> = {
  surface: true,
  text: true,
  brand: true,
  state: false,
  sidebar: false,
}

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
  /** Localised group label (e.g., "Surface"). */
  label: string
  tokens: readonly (keyof ThemeColors)[]
  /** Whether the group is initially expanded. */
  defaultOpen: boolean
  /** Per-token current value (falls back to `fallback[key]`). */
  values: Partial<ThemeColors>
  fallback: ThemeColors
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
}

export function TokenGroup({
  groupKey,
  label,
  tokens,
  defaultOpen,
  values,
  fallback,
  audit,
  tokenLabel,
  swatchAriaLabel,
  hexAriaLabel,
  auditChipLabel,
  failureBadgeLabel,
  onChange,
}: TokenGroupProps) {
  const failureCount = countGroupFailures(audit, tokens)
  return (
    <Collapsible defaultOpen={defaultOpen} data-token-group={groupKey}>
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
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 xl:grid-cols-2">
          {tokens.map((key) => (
            <div key={key} className="flex items-center gap-2">
              <ColorTokenRow
                tokenKey={key}
                label={tokenLabel(key)}
                value={values[key] ?? fallback[key]}
                onChange={(next) => onChange(key, next)}
                className="flex-1"
                swatchAriaLabel={swatchAriaLabel(key)}
                hexAriaLabel={hexAriaLabel(key)}
              />
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
