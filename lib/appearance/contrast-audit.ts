import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { wcagContrast } from "./contrast"

export interface AuditFailure {
  pair: [keyof ThemeColors, keyof ThemeColors]
  ratio: number
}

export interface ContrastAudit {
  failures: AuditFailure[]
  /** Total pairs checked (currently 8). */
  totalPairs: number
  /** Convenience: failures.length */
  failureCount: number
}

/**
 * The eight (foreground, background) pairs that determine how readable a
 * theme is in practice. Audited against WCAG AA (4.5:1).
 */
const CRITICAL_PAIRS: ReadonlyArray<[keyof ThemeColors, keyof ThemeColors]> = [
  ["foreground", "background"],
  ["cardForeground", "card"],
  ["popoverForeground", "popover"],
  ["primaryForeground", "primary"],
  ["destructiveForeground", "destructive"],
  ["mutedForeground", "muted"],
  ["accentForeground", "accent"],
  ["sidebarForeground", "sidebar"],
]

export function auditThemeContrast(tokens: ThemeColors): ContrastAudit {
  const failures: AuditFailure[] = []
  for (const [fg, bg] of CRITICAL_PAIRS) {
    const ratio = wcagContrast(tokens[fg], tokens[bg])
    if (ratio < 4.5) failures.push({ pair: [fg, bg], ratio })
  }
  return {
    failures,
    totalPairs: CRITICAL_PAIRS.length,
    failureCount: failures.length,
  }
}

/**
 * Quick helper for the "is this pair flagged" check used per-row in the
 * theme editor. Avoids re-running the audit per render.
 */
export function isFlaggedPair(audit: ContrastAudit, key: keyof ThemeColors): boolean {
  return audit.failures.some(({ pair }) => pair[0] === key || pair[1] === key)
}
