/**
 * Goal → `appendSystemPrompt` bridge.
 *
 * `resolveSendOptions` in `lib/claude/build-options.ts` already has a
 * conventional way to add prompt sections without disturbing the
 * base/character/skill/mode pipeline: the `appendSystemPrompt` field on
 * `SendOptions`. The A2UI and brief-mode injections both use it.
 *
 * This helper does the same for an active goal — keeping the surgical
 * change in `build-options.ts` to a single import + one `if` block while
 * the actual formatting logic (and tests for it) stay here.
 */

import type { Goal } from "@/types/goal"
import { renderGoalSystemSection } from "./prompts"
import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@cognia/logging"

/**
 * If `goal` is in the `active` state, returns the new value for
 * `opts.appendSystemPrompt`. Otherwise returns the unchanged input.
 *
 * The append uses the existing convention seen in `build-options.ts`:
 * sections are joined with two newlines so they read as distinct paragraphs
 * to the model. Empty / whitespace-only existing sections are normalised
 * away so the output never starts with the joiner.
 */
export function appendGoalContext(opts: {
  appendSystemPrompt?: string
  activeGoal?: Goal | null
}): string | undefined {
  const goal = opts.activeGoal
  if (!goal || goal.status !== "active") return opts.appendSystemPrompt
  const section = renderGoalSystemSection(goal)
  // PII red-line: the goal text is human-editable and flows straight into the
  // outbound system prompt. Skip the injection if it carries leaking PII rather
  // than send it to the model (matches the connector auto-mode safe-send gate).
  if (!hasNoLeakingPii(section)) {
    loggers.agent.warn("Goal context carries PII; skipping system-prompt injection")
    return opts.appendSystemPrompt
  }
  const existing = opts.appendSystemPrompt?.trim() ?? ""
  return existing.length > 0 ? `${existing}\n\n${section}` : section
}
