/**
 * Projection between the IM connector's legacy mode stack and the composed
 * agent-mode axes (ADR-0117).
 *
 * The connector carried two independent enums — `ConnectorMode`
 * (`auto`/`manual`/`draft`) for "does the bot answer, and does a human sign
 * off", and `ImExecutionTarget` (`direct`/`team`/`workflow`) for "who runs
 * this". Together they meant what the composition axes now mean explicitly.
 * This module is the only place that knows the correspondence, in both
 * directions:
 *
 *   - **read** — a stored row without axis fields still resolves, so no
 *     backfill is owed and an unmigrated deployment behaves identically.
 *   - **write** — every axis write mirrors `mode` back, so an older client, an
 *     export, and the scheduled-digest path (which reads `mode` through
 *     `InboxSendPolicy.forcedMode` and has no mode router of its own) keep
 *     working. That is what makes a rollback need no reverse migration.
 *
 * The mirror is deliberately lossy in one direction only: `confirm` and
 * `autopilot` have no legacy spelling and both mirror to `auto`, because both
 * do answer. Nothing reads the mirror in preference to the axes, so the loss
 * is confined to clients that predate the axes.
 */

import type {
  AgentAuthority,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"
import type { ConnectorMode } from "@/types/connectors/policy"

/** The execution-target kinds the connector can route to. */
export type ImTargetKind = "direct" | "team" | "workflow"

/**
 * `manual` → `observe`, `draft` → `suggest`, `auto` → `act`.
 *
 * `act` rather than `autopilot` for `auto`: the connector has always capped an
 * auto-replying bot below "may do anything without asking", and `act`'s
 * `acceptEdits` cap is that ceiling stated in axis terms.
 */
export function autonomyFromConnectorMode(mode: ConnectorMode): AutonomyLevel {
  switch (mode) {
    case "manual":
      return "observe"
    case "draft":
      return "suggest"
    case "auto":
      return "act"
  }
}

/**
 * Engagement follows the *target*, not the mode — which is precisely the bug
 * the axes fix.
 *
 * The old `draft-prepare` route branch resolved no target at all, so a
 * conversation bound to a team silently produced a single-character draft. Here
 * a team-bound conversation is `background` whatever its autonomy, and the
 * autonomy is what later decides whether the team's product ships or waits for
 * a human. `manual` is the one mode that overrides the target, because no agent
 * loop runs at all when the work belongs to a person.
 */
export function engagementFromConnectorMode(
  mode: ConnectorMode,
  targetKind: ImTargetKind
): EngagementMode {
  if (mode === "manual") return "human"
  return targetKind === "direct" ? "inline" : "background"
}

/**
 * The legacy spelling to mirror alongside an axis write.
 *
 * `human` engagement and `observe` autonomy both mean "the bot is not
 * answering", which is what `manual` meant. Everything else that answers
 * mirrors to `auto` unless it holds its product for review.
 */
export function connectorModeFromComposition(
  autonomy: AutonomyLevel,
  engagement: EngagementMode
): ConnectorMode {
  if (engagement === "human" || autonomy === "observe") return "manual"
  if (autonomy === "suggest") return "draft"
  return "auto"
}

/**
 * `approvalMode` was a second permission model: `"yolo"` auto-approved every
 * ask-tier tool, which is `bypassPermissions` scoped by the IM ceiling — and
 * the ceiling's `disallowedTools` applied either way, so nothing is widened by
 * saying so in authority terms.
 *
 * `undefined` maps to `undefined` rather than to `default`: an unset
 * `approvalMode` is "no opinion", and collapsing it to an explicit `default`
 * would let a conversation that never chose anything override a preset
 * recommendation.
 */
export function authorityFromApprovalMode(
  approvalMode: "prompt" | "yolo" | undefined
): AgentAuthority | undefined {
  if (approvalMode === "yolo") return "bypassPermissions"
  if (approvalMode === "prompt") return "default"
  return undefined
}

/** The legacy spelling to mirror alongside an authority write. */
export function approvalModeFromAuthority(
  authority: AgentAuthority | undefined
): "prompt" | "yolo" | undefined {
  if (authority === undefined) return undefined
  return authority === "bypassPermissions" ? "yolo" : "prompt"
}

/**
 * Resolve the axis values a stored row means, preferring the axis fields and
 * falling back to the legacy pair.
 *
 * Kept as one function rather than three so a caller cannot read `autonomy`
 * from the new field and `engagement` from the legacy one and end up with a
 * pair that never existed.
 */
export function projectStoredMode(input: {
  mode: ConnectorMode
  targetKind: ImTargetKind
  autonomy?: AutonomyLevel
  engagement?: EngagementMode
  approvalMode?: "prompt" | "yolo"
  authority?: AgentAuthority
}): { autonomy: AutonomyLevel; engagement: EngagementMode; authority: AgentAuthority | undefined } {
  return {
    autonomy: input.autonomy ?? autonomyFromConnectorMode(input.mode),
    engagement: input.engagement ?? engagementFromConnectorMode(input.mode, input.targetKind),
    authority: input.authority ?? authorityFromApprovalMode(input.approvalMode),
  }
}
