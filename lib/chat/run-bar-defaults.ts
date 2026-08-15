/**
 * Leaf module: the run-status-bar metric defaults, with no imports beyond the
 * settings type. Split out of `run-bar-metrics.ts` (which pulls in
 * `lib/claude/usage`) so `lib/db/settings.ts` can spread the same object into
 * canonical `DEFAULTS` without a heavy / cyclic import (ADR-0127).
 */

import type { RunStatusBarSettings } from "@cognia/agent-config-types"

/**
 * Default metric visibility. Elapsed + output-tokens + speed + tools are on
 * (informative without $ clutter); cost + context% are opt-in — the composer's
 * `ContextUsageIndicator` already carries the exact model-sized context figure
 * right below the bar, so context% here is a redundant convenience.
 */
export const DEFAULT_RUN_STATUS_BAR: Required<RunStatusBarSettings> = {
  showElapsed: true,
  showOutputTokens: true,
  showSpeed: true,
  showCost: false,
  showContextPct: false,
  showTools: true,
}
