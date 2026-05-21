import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { adjustForegroundLightnessToTarget, wcagContrast } from "./contrast"
import type { WcagTarget } from "@/types/appearance"

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

// ----------------------------------------------------------------------------
// v47 — Batch audit + auto-fix (ADR-0029)
//
// The WCAG enforcement model (warn + one-click auto-fix) needs:
//   1. A batch audit that runs ALL critical pairs against a chosen target
//      (AA = 4.5, AAA = 7) and returns each failing pair's ratio.
//   2. An auto-fix that adjusts only the foreground colors (preserving the
//      designer's chosen surface hues) along the oklch L axis. Returns the
//      patched ThemeColors plus a list of which keys actually moved, so the
//      UI can highlight what changed.
// ----------------------------------------------------------------------------

/** Ratio threshold for a given WCAG target. `off` = always pass. */
export function targetRatio(target: WcagTarget): number {
  if (target === "off") return 0
  return target === "AAA" ? 7 : 4.5
}

export interface AuditTokensResult {
  failures: AuditFailure[]
  /** All pairs that were checked (target = AA pairs above). */
  totalPairs: number
  failureCount: number
  target: WcagTarget
}

/**
 * Like `auditThemeContrast` but parameterized by WCAG target. AA uses the
 * built-in 4.5:1 threshold; AAA tightens to 7:1. `off` short-circuits with
 * an empty failure list.
 */
export function auditTokens(tokens: ThemeColors, target: WcagTarget): AuditTokensResult {
  const threshold = targetRatio(target)
  if (threshold === 0) {
    return { failures: [], totalPairs: CRITICAL_PAIRS.length, failureCount: 0, target }
  }
  const failures: AuditFailure[] = []
  for (const [fg, bg] of CRITICAL_PAIRS) {
    const ratio = wcagContrast(tokens[fg], tokens[bg])
    if (ratio < threshold) failures.push({ pair: [fg, bg], ratio })
  }
  return {
    failures,
    totalPairs: CRITICAL_PAIRS.length,
    failureCount: failures.length,
    target,
  }
}

export interface AutoFixViolationsResult {
  /** Patched copy of the tokens. */
  tokens: ThemeColors
  /** Keys whose value the auto-fix actually changed. */
  movedKeys: Array<keyof ThemeColors>
  /** Pairs that could not be repaired (e.g. background unreachable). */
  unfixable: AuditFailure[]
}

/**
 * Patch every failing pair by adjusting the *foreground* color along the
 * oklch L axis until the contrast ratio meets `target`. The surface
 * (background) is left untouched on purpose — designers pick surfaces for
 * aesthetic identity; foregrounds are utility.
 *
 * When a foreground is shared by multiple failing pairs (rare but possible),
 * we adjust it once against the worst-case background among those pairs so
 * one fix doesn't break another. Returns the keys that actually moved plus
 * the pairs the adjuster couldn't solve.
 */
export function autoFixViolations(
  tokens: ThemeColors,
  target: WcagTarget
): AutoFixViolationsResult {
  const threshold = targetRatio(target)
  if (threshold === 0) {
    return { tokens: { ...tokens }, movedKeys: [], unfixable: [] }
  }
  const audit = auditTokens(tokens, target)
  if (audit.failureCount === 0) {
    return { tokens: { ...tokens }, movedKeys: [], unfixable: [] }
  }

  // Group failures by foreground key so each fg is adjusted once against the
  // worst-case bg it pairs with.
  const byForeground = new Map<keyof ThemeColors, AuditFailure[]>()
  for (const failure of audit.failures) {
    const fg = failure.pair[0]
    const list = byForeground.get(fg) ?? []
    list.push(failure)
    byForeground.set(fg, list)
  }

  const patched: ThemeColors = { ...tokens }
  const movedKeys: Array<keyof ThemeColors> = []
  const unfixable: AuditFailure[] = []

  for (const [fgKey, failures] of byForeground.entries()) {
    // Pick the failure with the lowest current ratio — fixing for that pair
    // also fixes all others sharing this foreground (because the ratio is
    // monotonic in foreground luminance for a fixed bg).
    const worst = failures.reduce((a, b) => (a.ratio < b.ratio ? a : b))
    const bgKey = worst.pair[1]
    const fixed = adjustForegroundLightnessToTarget(patched[fgKey], patched[bgKey], threshold)
    if (!fixed) {
      unfixable.push(...failures)
      continue
    }
    patched[fgKey] = fixed
    movedKeys.push(fgKey)
  }

  // Re-audit to catch pairs that remained below threshold due to interaction
  // (shouldn't happen with the monotonic argument above, but the audit is
  // cheap and the safety check keeps the API honest).
  const verify = auditTokens(patched, target)
  if (verify.failureCount > 0) {
    for (const f of verify.failures) {
      const alreadyListed = unfixable.some(
        (u) => u.pair[0] === f.pair[0] && u.pair[1] === f.pair[1]
      )
      if (!alreadyListed) unfixable.push(f)
    }
  }

  return { tokens: patched, movedKeys, unfixable }
}
