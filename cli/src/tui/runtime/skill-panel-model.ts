/**
 * Pure presentation model for the interactive `/skill` panel. Projects the rich
 * `Skill` record (description, origin, category, usage, validation errors) the
 * old `/skill list` hid into one browsable row, with a fuzzy filter and an
 * enabled/validation badge. Ink-free, so the metadata layout unit-tests without
 * a render; the component (`components/SkillPanel.tsx`) owns only query +
 * highlight.
 */
import type { Skill } from "@cognia/agent-config-types"

import { skillOriginLabel } from "../../skill/discover-skills"
import { fuzzyFilter } from "./fuzzy-filter"

/** One row in the skills list — the metadata distilled for one-glance browsing. */
export interface SkillPanelRow {
  id: string
  name: string
  description?: string
  /** Reused-source label (claude / codex / opencode / project / …) or null. */
  origin: string | null
  source?: string
  category?: string
  enabled: boolean
  usageCount?: number
  /** Count of frontmatter validation errors (a `⚠` marker when > 0). */
  errorCount: number
}

/** Build the panel rows from the loaded skills + the session-enabled id set. */
export function buildSkillRows(skills: Skill[], enabled: Set<string>): SkillPanelRow[] {
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    origin: skillOriginLabel(s.canonicalId) ?? null,
    source: s.source,
    category: s.category,
    enabled: enabled.has(s.id),
    usageCount: s.usageCount,
    errorCount: s.validationErrors?.length ?? 0,
  }))
}

/** The leading enabled/validation badge: `●` on (accent), `○` off (muted),
 * plus a `⚠` token name when the skill has validation errors. */
export interface SkillBadge {
  glyph: string
  token: "success" | "muted"
  warn: boolean
}

export function skillBadge(row: SkillPanelRow): SkillBadge {
  return {
    glyph: row.enabled ? "●" : "○",
    token: row.enabled ? "success" : "muted",
    warn: row.errorCount > 0,
  }
}

/**
 * The dimmed metadata suffix shown after a skill's name: origin · category ·
 * "used N×" · "N issues". Empty segments are dropped; returns "" when there is
 * nothing to add.
 */
export function skillRowHint(row: SkillPanelRow): string {
  const parts: string[] = []
  if (row.origin) parts.push(row.origin)
  else if (row.source && row.source !== "builtin") parts.push(row.source)
  if (row.category && row.category !== "custom") parts.push(row.category)
  if (row.usageCount && row.usageCount > 0) parts.push(`used ${row.usageCount}×`)
  if (row.errorCount > 0) parts.push(`${row.errorCount} issue${row.errorCount === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

/** Fuzzy-filter the rows by name + description (empty query keeps order). */
export function filterSkillRows(rows: SkillPanelRow[], query: string): SkillPanelRow[] {
  return fuzzyFilter(rows, query, (r) => [r.name, r.description ?? ""])
}

/** Counts for the panel header: total / enabled / with-issues. */
export function skillSummary(rows: SkillPanelRow[]): {
  total: number
  enabled: number
  issues: number
} {
  return {
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    issues: rows.filter((r) => r.errorCount > 0).length,
  }
}

export const SKILL_PANEL_FOOTER =
  "filter · ↑/↓ / click · space toggle · ^A all on · ^D all off · ^T mode · enter detail · ^N new · ^X delete · esc"
