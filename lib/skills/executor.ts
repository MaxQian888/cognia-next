/**
 * Bridge to cognia-next's existing skills system.
 *
 * This module exposes the legacy `buildProgressiveSkillsPrompt` /
 * `executeSkill` symbols expected by upstream agent code, but does NOT
 * duplicate any of cognia-next's skill model. It delegates to:
 *   - `Skill` type from `@cognia/agent-config-types`
 *   - `renderSkillsSection` from `@/lib/db/skills`
 *
 * Anything fancier (token-budgeted progressive disclosure, MCP-aware
 * skill execution) is intentionally a thin wrapper today and can be
 * fleshed out in place when the agent-trace / planning layers land.
 */

import type { Skill } from "@cognia/agent-config-types"
import { renderSkillsSection } from "@/lib/db/skills"

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
 * prompt fragment. The `maxTokens` parameter is currently advisory only
 * (no truncation); add a tokenizer-aware trimmer here if needed.
 */
export function buildProgressiveSkillsPrompt(
  activeSkills: Skill[],
  _maxTokens?: number
): { prompt: string } {
  return { prompt: renderSkillsSection(activeSkills) }
}
