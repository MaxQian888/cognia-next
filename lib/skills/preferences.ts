/**
 * Skill panel preferences — the resolved shape, defaults, and a read-time
 * resolver for the user-customizable options exposed through the skill panel's
 * gear popover.
 *
 * Persistence mirrors `skillBundleMirrors` (see `stores/settings/settings-store`):
 * the raw value is stored as an all-optional partial on `AppSettings`, and
 * defaults are applied here at read time so existing installs pick up new
 * fields without a Dexie migration. This module is a **leaf** — it imports only
 * base types (`@/lib/claude/types`) and type-only literals from the skills
 * store, so `lib/claude/types.ts` can stay import-free of the store.
 */

import type { SkillCategory, SkillSource, SkillStatus } from "@/lib/claude/types"
// Type-only imports — erased at compile time, so no runtime coupling to the
// Zustand store (and no import cycle through `AppSettings`).
import type { SkillPanelTab, SkillSortMode } from "@/stores/skills"

/** Row density for the master-detail skill list. */
export type SkillListDensity = "comfortable" | "compact"
/** List vs. grid layout for the skill list pane. */
export type SkillListViewMode = "list" | "grid"

/** Fully-resolved skill panel preferences (every field present). */
export interface SkillPanelPrefs {
  // --- Display ---
  /** Row spacing/typography density. */
  density: SkillListDensity
  /** List rows vs. a responsive card grid. */
  viewMode: SkillListViewMode
  /** Show each skill's description line under its name. */
  showDescription: boolean
  /** Show up to a few tag chips on each row/card. */
  showTags: boolean
  /** Show the skill's source badge (custom / builtin / claude-code / …). */
  showSource: boolean
  /** Show the skill's cumulative usage count. */
  showUsage: boolean

  // --- Panel persistence ---
  /** Tab selected when the panel first mounts. */
  defaultTab: SkillPanelTab
  /** Sort mode seeded into the My Skills list. */
  defaultSort: SkillSortMode
  /** Status filter seeded into the My Skills list (e.g. hide disabled). */
  defaultStatusFilter: SkillStatus | "all"
  /** Persist the last tab/sort/filters (except the search query) across visits. */
  rememberLastView: boolean

  // --- Injection behavior ---
  /** Newly created/imported skills default to enabled (vs. disabled). */
  autoEnableNew: boolean
  /**
   * Advisory: when > 0 and the enabled-skill count exceeds it, the list pane
   * shows a token-budget warning banner. Purely a display-side hint — it never
   * touches the send-time injection path. `0` disables the warning.
   */
  enabledWarnThreshold: number
}

/** All-optional partial as stored on `AppSettings.skillPanelPrefs`. */
export type PartialSkillPanelPrefs = Partial<SkillPanelPrefs>

/** The persisted "last view" snapshot (written only when `rememberLastView`). */
export interface LastSkillView {
  tab: SkillPanelTab
  sort: SkillSortMode
  category: SkillCategory | "all"
  source: SkillSource | "all"
  status: SkillStatus | "all"
  /** Selected tag filter, or null for none. */
  tag: string | null
}

export type PartialLastSkillView = Partial<LastSkillView>

/** Upper bound for the enabled-skill warning threshold input. */
export const SKILL_ENABLED_WARN_MAX = 100

/** Baseline defaults — chosen to preserve the current panel look/behavior. */
export const DEFAULT_SKILL_PANEL_PREFS: SkillPanelPrefs = {
  density: "comfortable",
  viewMode: "list",
  showDescription: true,
  showTags: false,
  showSource: false,
  showUsage: false,
  defaultTab: "my-skills",
  defaultSort: "name",
  defaultStatusFilter: "all",
  rememberLastView: false,
  autoEnableNew: true,
  enabledWarnThreshold: 0,
}

const VALID_TABS: readonly SkillPanelTab[] = ["my-skills", "browse", "editor", "analytics"]
const VALID_SORTS: readonly SkillSortMode[] = ["name", "updated", "usage"]
const VALID_STATUS: readonly (SkillStatus | "all")[] = ["all", "enabled", "disabled", "error"]

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Clamp the warning threshold to a non-negative integer within bounds. */
export function clampEnabledWarnThreshold(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0
  if (n <= 0) return 0
  return Math.min(n, SKILL_ENABLED_WARN_MAX)
}

/**
 * Resolve the raw (possibly `undefined`/partial) stored value into a complete
 * `SkillPanelPrefs`, applying defaults and validating enum-ish fields so a
 * corrupt or forward-incompatible value can never break the panel. Pure — safe
 * to call from non-React contexts.
 */
export function resolveSkillPanelPrefs(
  raw: PartialSkillPanelPrefs | null | undefined
): SkillPanelPrefs {
  const d = DEFAULT_SKILL_PANEL_PREFS
  if (!raw) return { ...d }
  return {
    density: oneOf<SkillListDensity>(raw.density, ["comfortable", "compact"], d.density),
    viewMode: oneOf<SkillListViewMode>(raw.viewMode, ["list", "grid"], d.viewMode),
    showDescription: raw.showDescription ?? d.showDescription,
    showTags: raw.showTags ?? d.showTags,
    showSource: raw.showSource ?? d.showSource,
    showUsage: raw.showUsage ?? d.showUsage,
    defaultTab: oneOf<SkillPanelTab>(raw.defaultTab, VALID_TABS, d.defaultTab),
    defaultSort: oneOf<SkillSortMode>(raw.defaultSort, VALID_SORTS, d.defaultSort),
    defaultStatusFilter: oneOf<SkillStatus | "all">(
      raw.defaultStatusFilter,
      VALID_STATUS,
      d.defaultStatusFilter
    ),
    rememberLastView: raw.rememberLastView ?? d.rememberLastView,
    autoEnableNew: raw.autoEnableNew ?? d.autoEnableNew,
    enabledWarnThreshold: clampEnabledWarnThreshold(raw.enabledWarnThreshold),
  }
}
