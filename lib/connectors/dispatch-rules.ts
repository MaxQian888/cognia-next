/**
 * Inbound dispatch rules — pure matcher + routing composition (W3 multi-bot).
 *
 * `matchDispatchRule` evaluates an adapter instance's declarative
 * `dispatchRules` (条件规则表 v1) against a normalized inbound event and
 * returns the FIRST enabled rule whose conditions all hold. Deterministic
 * condition table only — no AI triage in v1.
 *
 * `resolveEffectiveRouting` composes the final routing decision for the
 * runtime's ai-run branch. Precedence (user-confirmed):
 *   explicit conversation override (`/team`, `/character`, `/workflow`,
 *   `teamDisabled`) > first matching rule > instance defaults.
 * Runtime dispatch and `/status` both consume this resolver so the route
 * reported in chat cannot drift from the rule selected for that event.
 */

import type {
  AdapterInstanceRow,
  ConversationOverrideRow,
  DispatchRule,
  DispatchRuleAction,
} from "@/lib/db/connector-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface DispatchRuleHit {
  rule: DispatchRule
  action: DispatchRuleAction
}

/**
 * Compiled-regex cache keyed by pattern source. Invalid patterns are cached
 * as `null` so a bad rule costs exactly one failed compile per session
 * instead of one throw per inbound message.
 */
const regexCache = new Map<string, RegExp | null>()

function compilePattern(source: string): RegExp | null {
  const cached = regexCache.get(source)
  if (cached !== undefined) return cached
  let compiled: RegExp | null
  try {
    compiled = new RegExp(source)
  } catch {
    compiled = null
  }
  regexCache.set(source, compiled)
  return compiled
}

/** True when the action routes somewhere — rules with an empty action are inert. */
function actionHasTarget(action: DispatchRuleAction | undefined): boolean {
  if (!action) return false
  return Boolean(
    action.teamId?.trim() ||
    action.workflowId?.trim() ||
    action.characterId?.trim() ||
    action.respondViaAdapterId?.trim()
  )
}

/**
 * Evaluate the rule table against an inbound event.
 *
 * Semantics:
 *   - rules run in array order; the first hit wins.
 *   - `enabled === false` rules are skipped; rules whose action has no
 *     target are skipped.
 *   - a rule matches when ALL provided match fields hold (AND across
 *     fields); `keywords` / `senderIds` match on ANY entry (OR within a
 *     field). Empty arrays count as "not provided".
 *   - an empty/absent `match` object is a catch-all.
 *   - an invalid regex `pattern` makes that condition fail (the rule never
 *     matches); compilation results are cached by source.
 */
export function matchDispatchRule(
  rules: readonly DispatchRule[] | undefined,
  event: Pick<NormalizedInboundEvent, "plainText" | "sender" | "channel">
): DispatchRuleHit | null {
  if (!rules || rules.length === 0) return null
  const text = event.plainText
  const lowerText = text.toLowerCase()

  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (!actionHasTarget(rule.action)) continue
    const match = rule.match ?? {}

    const keywords = match.keywords?.filter((k) => k.length > 0) ?? []
    if (keywords.length > 0 && !keywords.some((k) => lowerText.includes(k.toLowerCase()))) {
      continue
    }

    if (match.pattern && match.pattern.length > 0) {
      const re = compilePattern(match.pattern)
      if (!re || !re.test(text)) continue
    }

    const senderIds = match.senderIds?.filter((s) => s.length > 0) ?? []
    if (
      senderIds.length > 0 &&
      !senderIds.some((id) => id === event.sender.id || id === event.sender.remoteUserId)
    ) {
      continue
    }

    const kinds = match.channelKinds ?? []
    if (kinds.length > 0 && !kinds.includes(event.channel.kind)) continue

    return { rule, action: rule.action }
  }
  return null
}

export interface EffectiveRouting {
  teamId: string | undefined
  /** Where the effective team came from — audited so operators can tell a
   * `/team`-bound chat from a rule hit from a bot-default dispatch. */
  teamSource: "override" | "rule" | "instance-default" | "none"
  workflowId: string | undefined
  workflowSource: "override" | "rule" | "instance-default" | "none"
  /**
   * Character routed by an override or a rule. `undefined` means "no
   * explicit routing here" — the caller falls back to the resolved binding
   * (`ResolvedBinding.characterId`, which already folds in the override and
   * the adapter default).
   */
  characterId: string | undefined
  characterSource: "override" | "rule" | "instance-default" | "none"
  /**
   * Bot instance the reply should be delivered through (multi-bot
   * cross-account send). Only a rule can set this in v1 — there is no
   * conversation-override or instance-default layer. `undefined` keeps
   * the receiving bot as the sender. The runtime validates the target
   * (exists, enabled, same platform) at dispatch time.
   */
  respondViaAdapterId: string | undefined
  respondViaSource: "rule" | "none"
}

/**
 * Compose the effective routing for one inbound ai-run turn.
 *
 * Team: `override.teamDisabled` (the `/team off` sentinel) suppresses
 * everything — including a rule-sourced team → explicit conversation
 * `teamId` → the matched rule's `teamId` → the bot instance's
 * `defaultTeamId` → none. Empty/whitespace ids are treated as unset.
 *
 * Workflow: `override.workflowId` → the matched rule's `workflowId` → none.
 * The runtime only dispatches a workflow when NO team resolved (teamId wins
 * over workflowId).
 *
 * Character: `override.characterId` → the matched rule's `characterId` →
 * none (caller falls back to the resolved binding).
 */
export function resolveEffectiveRouting(
  adapter: Pick<AdapterInstanceRow, "defaultTeamId" | "defaultWorkflowId" | "defaultCharacterId">,
  override: Pick<
    ConversationOverrideRow,
    | "teamId"
    | "teamDisabled"
    | "workflowId"
    | "workflowDisabled"
    | "characterId"
    | "characterDisabled"
  > | null,
  ruleHit: DispatchRuleHit | null
): EffectiveRouting {
  // ── team ──────────────────────────────────────────────────────────────────
  let teamId: string | undefined
  let teamSource: EffectiveRouting["teamSource"] = "none"
  if (override?.teamDisabled !== true) {
    const overrideTeamId = override?.teamId?.trim()
    const ruleTeamId = ruleHit?.action.teamId?.trim()
    const instanceTeamId = adapter.defaultTeamId?.trim()
    if (overrideTeamId) {
      teamId = overrideTeamId
      teamSource = "override"
    } else if (ruleTeamId) {
      teamId = ruleTeamId
      teamSource = "rule"
    } else if (instanceTeamId) {
      teamId = instanceTeamId
      teamSource = "instance-default"
    }
  }

  // ── workflow ──────────────────────────────────────────────────────────────
  let workflowId: string | undefined
  let workflowSource: EffectiveRouting["workflowSource"] = "none"
  if (override?.workflowDisabled !== true) {
    const overrideWorkflowId = override?.workflowId?.trim()
    const ruleWorkflowId = ruleHit?.action.workflowId?.trim()
    const instanceWorkflowId = adapter.defaultWorkflowId?.trim()
    if (overrideWorkflowId) {
      workflowId = overrideWorkflowId
      workflowSource = "override"
    } else if (ruleWorkflowId) {
      workflowId = ruleWorkflowId
      workflowSource = "rule"
    } else if (instanceWorkflowId) {
      workflowId = instanceWorkflowId
      workflowSource = "instance-default"
    }
  }

  // ── character ─────────────────────────────────────────────────────────────
  let characterId: string | undefined
  let characterSource: EffectiveRouting["characterSource"] = "none"
  if (override?.characterDisabled !== true) {
    const overrideCharacterId = override?.characterId?.trim()
    const ruleCharacterId = ruleHit?.action.characterId?.trim()
    const instanceCharacterId = adapter.defaultCharacterId?.trim()
    if (overrideCharacterId) {
      characterId = overrideCharacterId
      characterSource = "override"
    } else if (ruleCharacterId) {
      characterId = ruleCharacterId
      characterSource = "rule"
    } else if (instanceCharacterId) {
      characterId = instanceCharacterId
      characterSource = "instance-default"
    }
  }

  // ── respond-via bot (rule-only layer) ─────────────────────────────────────
  let respondViaAdapterId: string | undefined
  let respondViaSource: EffectiveRouting["respondViaSource"] = "none"
  const ruleRespondVia = ruleHit?.action.respondViaAdapterId?.trim()
  if (ruleRespondVia) {
    respondViaAdapterId = ruleRespondVia
    respondViaSource = "rule"
  }

  return {
    teamId,
    teamSource,
    workflowId,
    workflowSource,
    characterId,
    characterSource,
    respondViaAdapterId,
    respondViaSource,
  }
}
