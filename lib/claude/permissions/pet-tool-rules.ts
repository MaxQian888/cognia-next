/**
 * Baked-in consent tier for the agent's pet tools.
 *
 * The point of this ruleset is mostly to REMOVE prompts, not add them. Without
 * a rule, a non-shell tool falls through to a human approval on every call, so
 * asking "how is my pet?" would raise a dialog. Four of the five are allowed
 * for that reason, and because the enforcement that matters is elsewhere: the
 * whole family is off until the user turns it on in Settings, the pet's own
 * access gate applies the cooldown and the daily budget, and rewards are
 * clamped rather than trusted.
 *
 * - `pet_status`: reads the user's own pet. Allowed.
 * - `pet_care`: cooldown-bounded, and the effect is a mood bar moving. Allowed.
 * - `pet_say`: spends the same speak budget the user's own conversation
 *   spends, so it cannot out-talk them. Allowed.
 * - `pet_reward`: clamped per call and against a daily ledger. A per-call
 *   dialog on a bounded grant is the click-through trap. Allowed.
 * - `pet_show`: asks. It raises an always-on-top window over whatever the user
 *   is doing, and it persists `desktopPet.enabled`, so it changes a setting
 *   and the screen at once. That one is worth a question.
 *
 * Precedence: merged as the LOWEST layer of `opts.permissionRuleset`, so an
 * explicit rule in Settings, Agent, Permissions overrides any of it in either
 * direction.
 */
import { PET_SHOW_TOOL_NAME, PET_TOOL_NAMES } from "@/lib/claude/pet-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/**
 * Server segment plugin-contributed tools are namespaced under on the AI-SDK
 * path (`mcp__cognia-plugin-tools__<tool>`), mirroring
 * `PLUGIN_TOOLS_SERVER_NAME` in `sidecar/dispatch/ai-sdk-tools.mjs`.
 */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

function verdictFor(tool: string): PermissionVerdict {
  return tool === PET_SHOW_TOOL_NAME ? "ask" : "allow"
}

/**
 * Each tool is keyed **twice**, bare and `mcp__`-prefixed, because the two
 * provider paths disagree on which reaches `canUseTool`: the Anthropic path
 * sees the bare name, the AI-SDK path the namespaced one, and
 * `resolveToolVerdict` matches the key exactly with no prefix stripping. Keying
 * one form applies the tier on one provider only.
 */
export function buildPetToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of PET_TOOL_NAMES) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
