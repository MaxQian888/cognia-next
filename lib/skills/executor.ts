/**
 * Bridge to cognia-next's existing skills system.
 *
 * This module exposes the legacy `buildProgressiveSkillsPrompt` /
 * `executeSkill` symbols expected by upstream agent code, but does NOT
 * duplicate any of cognia-next's skill model. It delegates to:
 *   - `Skill` type from `@cognia/agent-config-types`
 *   - `renderSkillsSection` from `@/lib/db/skills`
 *
 * MCP-aware skill execution is intentionally a thin wrapper today and can
 * be fleshed out in place when the agent-trace / planning layers land.
 */

import type { Skill } from "@cognia/agent-config-types"
import { renderSkillsSection, type RenderSkillsBudget } from "@/lib/db/skills"

export interface SkillExecutionContext {
  skillId: string
  args?: Record<string, unknown>
}

export interface SkillExecutionResult {
  output: string
  metadata?: Record<string, unknown>
}

/**
 * Stub for skill *execution* — cognia-next applies skills by appending
 * their markdown to the system prompt at send-time (see
 * `lib/claude/build-options.ts`). There is no separate execution call,
 * so this returns an empty result. Wire to a real executor if/when
 * skills become first-class tools.
 */
export async function executeSkill(_ctx: SkillExecutionContext): Promise<SkillExecutionResult> {
  return { output: "" }
}

export const skillsExecutor = {
  execute: executeSkill,
}

/**
 * Build the system-prompt block for a list of active skills. Wraps
 * cognia-next's existing `renderSkillsSection` so the External Agent
 * instruction stack and the Claude SDK build pipeline produce the same
 * prompt fragment.
 *
 * `maxTokens` is enforced: bodies that do not fit are omitted whole, never
 * truncated (see `lib/skills/prompt-budget.ts` for why). Omit it to render
 * everything. It used to be accepted and silently ignored — the one caller
 * that passes a budget, `external-agent-instruction-stack.ts`, asked for
 * 1024 tokens and got however many the library happened to be.
 */
export function buildProgressiveSkillsPrompt(
  activeSkills: Skill[],
  maxTokens?: number,
  onDegrade?: RenderSkillsBudget["onDegrade"]
): { prompt: string } {
  return {
    prompt: renderSkillsSection(activeSkills, {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(onDegrade ? { onDegrade } : {}),
    }),
  }
}
