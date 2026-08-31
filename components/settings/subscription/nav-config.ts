// Nav shape for the Subscription section. Split out of `subscription-section.tsx`
// so `SubscriptionNav` can type against it without importing the section back.
// Mirrors `appearance/nav-config.ts`, the house pattern for master/detail
// sections.
//
// This replaces a two-level tab strip (provider Tabs → Anthropic inner Tabs).
// The nesting was the problem: the Claude account list and preset picker sat
// ABOVE the inner strip, so "Overview" and "Usage" were visually children of
// Claude while `usage-tab` has stacked every provider's meters for a while now.
// Flattening drops the second level and groups by *concern* instead:
//
//   • usageGroup     — read your numbers (cross-provider).
//   • providersGroup — one panel per provider: accounts, quota, presets, and
//     that provider's own connection settings. Codex/OpenCode were already
//     shaped this way; `claude` is the Anthropic equivalent, assembled in
//     `panels/claude-account-panel.tsx`.
//   • vaultGroup     — the vault-wide affordances that used to hang off the
//     bottom of the section with no nav entry at all.

import {
  CloudIcon,
  DatabaseBackupIcon,
  GaugeIcon,
  KeyRoundIcon,
  RadioIcon,
  SparklesIcon,
  TerminalIcon,
  ChartColumnIcon,
  UsersIcon,
} from "lucide-react"
import type { ComponentType } from "react"

export type SubscriptionPanelId =
  "overview" | "usage" | "probes" | "accounts" | "claude" | "codex" | "opencode" | "backup" | "sync"

export type SubscriptionNavGroupId = "usageGroup" | "providersGroup" | "vaultGroup"

export interface SubscriptionNavItem {
  id: SubscriptionPanelId
  icon: ComponentType<{ className?: string }>
}

export interface SubscriptionNavGroup {
  id: SubscriptionNavGroupId
  items: readonly SubscriptionNavItem[]
}

// Group ids are suffixed so `nav.groups.usageGroup` never reads as
// `nav.items.usage` at a glance.
export const SUBSCRIPTION_NAV_GROUPS: readonly SubscriptionNavGroup[] = [
  {
    id: "usageGroup",
    items: [
      { id: "overview", icon: GaugeIcon },
      { id: "usage", icon: ChartColumnIcon },
      { id: "probes", icon: RadioIcon },
    ],
  },
  {
    id: "providersGroup",
    items: [
      { id: "accounts", icon: UsersIcon },
      { id: "claude", icon: SparklesIcon },
      { id: "codex", icon: TerminalIcon },
      { id: "opencode", icon: KeyRoundIcon },
    ],
  },
  {
    id: "vaultGroup",
    items: [
      { id: "backup", icon: DatabaseBackupIcon },
      { id: "sync", icon: CloudIcon },
    ],
  },
]

const PANEL_IDS = new Set<string>(
  SUBSCRIPTION_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))
)

/**
 * Old `?innerTab=` values, which only ever applied to the Anthropic provider.
 * `account` became the Claude provider panel (it now owns the account list and
 * preset picker that used to sit above the inner strip); `settings` became
 * `probes`, which is what that pane actually configures.
 */
const LEGACY_INNER_TAB_ALIASES: Record<string, SubscriptionPanelId> = {
  overview: "overview",
  usage: "usage",
  account: "accounts",
  settings: "probes",
}

/** Landing panel: your numbers, which is what the section is opened to check. */
export const DEFAULT_SUBSCRIPTION_PANEL: SubscriptionPanelId = "overview"

/**
 * Resolve the active panel from the URL.
 *
 * `?subTab=` is now the single source of truth and carries a panel id. The two
 * legacy params are still honored so pre-merge deep links keep resolving:
 *   • `?subTab=codex|opencode` — already a panel id, passes through.
 *   • `?subTab=anthropic&innerTab=X` — the old nested form; `innerTab` wins and
 *     maps through `LEGACY_INNER_TAB_ALIASES`.
 *   • `?subTab=anthropic` alone — landed on the Anthropic overview, so it still
 *     does (via the default).
 *
 * The URL is left as-is rather than rewritten, which would cost an effect and a
 * history entry for no user-visible gain (same call as `appearance/nav-config`).
 */
export function resolveSubscriptionPanel(
  subTab: string | null,
  innerTab: string | null
): SubscriptionPanelId {
  // The legacy nested form: `innerTab` only ever meant anything under Anthropic.
  if (innerTab && (!subTab || subTab === "anthropic")) {
    const mapped = LEGACY_INNER_TAB_ALIASES[innerTab]
    if (mapped) return mapped
    return DEFAULT_SUBSCRIPTION_PANEL
  }
  if (!subTab || subTab === "anthropic") return DEFAULT_SUBSCRIPTION_PANEL
  if (!PANEL_IDS.has(subTab)) return DEFAULT_SUBSCRIPTION_PANEL
  return subTab as SubscriptionPanelId
}
