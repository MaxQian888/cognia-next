// Surface-aware auto-activation of built-in functional skills.
//
// The generic chat-skill path (lib/claude/build-options.ts) only injects skills
// a character/user explicitly enabled. But the most useful place for a
// function-guidance skill is exactly the surface that function runs on — IM
// auto-reply should get the IM etiquette skill, a computer-use turn should get
// the safety skill, and so on, without the user having to remember to enable it.
//
// This module is the pure selector: build-options derives which surfaces are
// active from its context and asks here which built-in skills to inject. Keeping
// it free of the (large) BuildOptionsContext type makes it trivially testable and
// keeps the surface→skill mapping in one place — driven entirely by the
// `metadata.surface` tags authored in each SKILL.md.

import {
  BUILT_IN_SKILL_CATALOG,
  type BuiltInSkillCatalogEntry,
  type SurfaceId,
} from "./built-in-catalog"

/**
 * Lightweight, surface-detection signals build-options can cheaply compute from
 * its context. Each maps to a {@link SurfaceId}. All optional / default false.
 */
export interface SurfaceSignals {
  /** Replying over a platform connector (Slack/Lark/Discord/…). */
  imBound?: boolean
  /** Computer-use / desktop-automation tools are enabled this turn. */
  computerUse?: boolean
  /** Workflow-editor copilot session. (Handled in its own prompt block — the
   *  generic path skips skills for these sessions — but supported here for
   *  completeness and tests.) */
  workflowEditor?: boolean
  /** Multi-agent team / dispatch orchestration. */
  agentTeam?: boolean
  /** Twin retrieved-context is supplied this turn. */
  digitalTwin?: boolean
  /** A standing /goal or /loop run is driving the turns. */
  goalLoop?: boolean
}

const SIGNAL_TO_SURFACE: Array<[keyof SurfaceSignals, SurfaceId]> = [
  ["imBound", "im-connector"],
  ["computerUse", "computer-use"],
  ["workflowEditor", "workflow-editor"],
  ["agentTeam", "agent-team"],
  ["digitalTwin", "digital-twin"],
  ["goalLoop", "goal-loop"],
]

/** The set of active surface ids implied by the signals. */
export function activeSurfaces(signals: SurfaceSignals): SurfaceId[] {
  return SIGNAL_TO_SURFACE.filter(([key]) => signals[key]).map(([, surface]) => surface)
}

/**
 * Built-in catalog entries to auto-inject for the active surfaces. An entry is
 * selected when any of its `metadata.surface` tags matches an active surface.
 * Returned in catalog order, de-duplicated (an entry tagged for two active
 * surfaces appears once).
 */
export function selectSurfaceSkills(signals: SurfaceSignals): BuiltInSkillCatalogEntry[] {
  const surfaces = new Set<string>(activeSurfaces(signals))
  if (surfaces.size === 0) return []
  return BUILT_IN_SKILL_CATALOG.filter((entry) => entry.surface.some((s) => surfaces.has(s)))
}

/**
 * Render catalog entries as a system-prompt section, identical in shape to
 * `renderSkillsSection` for chat skills (`## <name>` + body, blank-line joined).
 * Returns `""` for an empty list so callers can skip an empty append.
 */
export function renderSurfaceSkillsSection(entries: BuiltInSkillCatalogEntry[]): string {
  if (entries.length === 0) return ""
  return entries.map((e) => `## ${e.name}\n\n${e.content.trim()}`).join("\n\n")
}
