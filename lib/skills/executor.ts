/**
 * Bridge to cognia-next's existing skills system.
 *
 * This module exposes the legacy `executeSkill` symbol expected by upstream
 * agent code, but does NOT duplicate any of cognia-next's skill model: skills
 * reach a model through `renderSkillsSection` (`@/lib/db/skills`), which the
 * send path calls directly.
 *
 * MCP-aware skill execution is intentionally a thin wrapper today and can
 * be fleshed out in place when the agent-trace / planning layers land.
 */

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
