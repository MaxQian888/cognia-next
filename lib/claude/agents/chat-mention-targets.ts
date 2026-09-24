/**
 * Chat composer `@agent` mention targets.
 *
 * The general chat composer lets the user `@`-mention a subagent to route a
 * single turn to it (the SDK-native `agent` field on the Anthropic path; a
 * synthetic system/tools overlay on the ai-sdk path). This module is the single
 * source of truth for THREE consumers that must agree exactly:
 *   1. the `@` popover list (via `useMentionableSubagents`),
 *   2. the send-time mention resolution (`resolveTargetAgentId`), and
 *   3. the build-options membership guard (it only sets `opts.agent` when the id
 *      is present in `opts.agents`).
 *
 * Keeping all three on `buildChatMentionTargets()` is what makes the picked
 * handle, the parsed id, and the registered agent map line up — no name drift.
 *
 * NOTE: This is deliberately a SEPARATE type from the team mention path's
 * `MentionTarget` (teammate | virtual). That type was coupled to the chat-tab
 * runtime dispatch ADR-0140 retired, whose modules have now been removed. A
 * subagent is a model-level identity rather than a runtime, so the two stay
 * separate on their own merits rather than because one of them had a
 * dependency the other did not.
 */

import { resolveDispatchableSubagents } from "@/lib/claude/agents/subagents"
import { slugify } from "@/lib/claude/subagent-importers/_parse-helpers"
import { parseMentions } from "@/lib/claude/team-router"
import type { MentionResolvers } from "@/lib/chat/mentions/resolve-mentions"
import { RESERVED_MENTION_NAMES } from "@/types/agent/agent-team"
import { findTargetByHandle, type MentionTarget } from "@/lib/agent-team/runtime-targets"

/**
 * `@claude` / `@codex` belong to the route targets (`lib/chat/turn-route/`),
 * which win every collision: a subagent called "Codex" must not answer a turn
 * the user addressed to the Codex runtime.
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set(RESERVED_MENTION_NAMES)

export interface SubagentMentionTarget {
  /** Projected dispatcher id — the key that must exist in `SendOptions.agents`. */
  id: string
  /** Display name (from the subagent def). */
  name: string
  /** Natural-language description shown in the picker row. */
  description: string
  /** Optional model alias / id, shown as a badge. */
  model?: string
  /**
   * No-whitespace token inserted as `@<handle>` and matched back to `id` at
   * send. Derived from the name via `slugify`; falls back to the full id when
   * two targets would otherwise collide on the same handle (keeps it unique
   * and reversible).
   */
  handle: string
}

/**
 * Build the ordered list of subagents the chat composer can `@`-mention:
 * the host built-ins + plugin-registered subagents + the user's own templates
 * (exactly what `resolveDispatchableSubagents()` already unions, with display
 * names and models preserved).
 *
 * Snapshot, not reactive — `resolveDispatchableSubagents()` reads the template
 * store via `getState()`. UI consumers wrap this in `useMentionableSubagents`
 * to re-render on store changes; the send path calls it directly per turn.
 */
export function buildChatMentionTargets(): SubagentMentionTarget[] {
  // `hidden` subagents stay dispatchable but never enter the @-mention picker
  // (OpenCode semantics); `disabled` ones are already dropped by the resolver.
  const entries = resolveDispatchableSubagents().filter(({ def }) => !def.hidden)

  // First pass: derive the preferred handle (slugified name) per target and
  // count collisions so the second pass can fall back to the full id.
  const handleCounts = new Map<string, number>()
  const preferred = entries.map(({ id, def }) => {
    const handle = slugify(def.name)
    handleCounts.set(handle, (handleCounts.get(handle) ?? 0) + 1)
    return { id, def, handle }
  })

  return preferred.map(({ id, def, handle }) => ({
    id,
    name: def.name,
    description: def.description,
    model: def.model,
    // Collision → use the unique (already no-whitespace) id as the handle so
    // picker insertion and send-time parsing stay 1:1 with the agent map key.
    // A reserved route name counts as a collision too.
    handle: (handleCounts.get(handle) ?? 0) > 1 || RESERVED_HANDLES.has(handle) ? id : handle,
  }))
}

/**
 * Resolve the FIRST `@`-mentioned subagent in `text` to its dispatcher id, or
 * null when none of the mentions match a known target.
 *
 * Reuses the team router's `parseMentions` scanner (full-text, longest-match-
 * first, deduped, word-boundary aware) by projecting targets to `{ id, name:
 * handle }`. First mention wins — only one agent runs the turn.
 */
export function resolveTargetAgentId(
  text: string,
  targets: readonly SubagentMentionTarget[]
): string | null {
  const matched = parseMentions(
    text,
    targets.map((t) => ({ id: t.id, name: t.handle }))
  )
  return matched[0]?.id ?? null
}

/**
 * The `MentionResolvers` every send path passes to
 * `resolveMentions`/`resolveTurnContextRefs`, built over the same target list
 * the picker offered. Centralised so a direct send, a steer, and a room turn
 * all resolve a handle to the identical `subagent` ref instead of drifting.
 *
 * Route handles resolve to an `agent` ref: `@claude` and `@codex` always, and
 * a Squad member's handle when the caller passes the conversation's route
 * targets (member handles depend on which Squads the conversation can see, so
 * only a caller that knows the conversation can spell them). Without this a
 * `@codex` was recorded as a FILE mention.
 */
export function chatMentionResolvers(routeTargets?: readonly MentionTarget[]): MentionResolvers {
  return {
    resolveAgentHandle: (name) => {
      const route = routeTargets
        ? findTargetByHandle(routeTargets, name)
        : RESERVED_HANDLES.has(name.toLowerCase())
          ? { handle: name.toLowerCase(), name: name.toLowerCase() }
          : null
      if (route) return { kind: "agent", id: route.handle, label: route.name }
      const hit = buildChatMentionTargets().find((t) => t.handle === name)
      return hit ? { kind: "subagent", id: hit.handle, label: hit.name } : null
    },
  }
}
