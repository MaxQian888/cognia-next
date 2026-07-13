/**
 * Plan → `appendSystemPrompt` bridge (ADR-0045).
 *
 * Mirrors `lib/goal/context-injector.ts:appendGoalContext`: it keeps the
 * surgical change in `lib/claude/build-options.ts:resolveSendOptions` to a
 * single import + one `if` block, while the formatting logic (and its tests)
 * live here next to `renderPlanSystemSection`.
 */

import type { AgentPlan } from "@/types/agent/plan"
import { renderPlanSystemSection } from "./prompts"
import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@/lib/logging"

/**
 * If `plan` is `executing`, returns the new value for `opts.appendSystemPrompt`
 * (existing section + the plan section, joined by a blank line). Otherwise
 * returns the unchanged input. Empty / whitespace-only existing sections are
 * normalised so the output never starts with the joiner.
 */
export function appendPlanContext(opts: {
  appendSystemPrompt?: string
  activePlan?: AgentPlan | null
}): string | undefined {
  const plan = opts.activePlan
  if (!plan || plan.status !== "executing") return opts.appendSystemPrompt
  const section = renderPlanSystemSection(plan)
  // PII red-line: the plan text is human-editable and flows straight into the
  // outbound system prompt. Skip the injection if it carries leaking PII rather
  // than send it to the model (matches the connector auto-mode safe-send gate).
  if (!hasNoLeakingPii(section)) {
    loggers.agent.warn("Plan context carries PII; skipping system-prompt injection")
    return opts.appendSystemPrompt
  }
  const existing = opts.appendSystemPrompt?.trim() ?? ""
  return existing.length > 0 ? `${existing}\n\n${section}` : section
}
