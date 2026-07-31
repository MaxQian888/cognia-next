/**
 * Create a goal from a template (ADR-0019 Phase 2). The single entry point
 * shared by the `/goal` slash command and the goals console — both resolve a
 * template then delegate to `GoalRuntime.createGoal`, so PII redaction, the
 * IM guardrail (`GoalImBlocked`), and the session-uniqueness invariant all
 * apply uniformly.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { Goal } from "@/types/goal"
import { getGoalTemplate } from "@/lib/db/goal-templates"
import { getGoalRuntime } from "./runtime"

export class GoalTemplateNotFound extends Error {
  readonly templateId: string
  constructor(templateId: string) {
    super(`goal template not found: ${templateId}`)
    this.name = "GoalTemplateNotFound"
    this.templateId = templateId
  }
}

/**
 * Resolve `templateId` and create a goal for `sessionId` from its objective +
 * config overrides. Throws `GoalTemplateNotFound` for an unknown id and
 * propagates `GoalImBlocked` from the runtime for IM-bound sessions.
 */
export async function createGoalFromTemplate(input: {
  templateId: string
  sessionId: string
  characterId?: string
  appSettings?: AppSettings | null
}): Promise<Goal> {
  const template = await getGoalTemplate(input.templateId)
  if (!template) throw new GoalTemplateNotFound(input.templateId)
  return getGoalRuntime().createGoal({
    sessionId: input.sessionId,
    characterId: input.characterId,
    rawObjective: template.objectiveText,
    config: template.configOverrides,
    appSettings: input.appSettings ?? null,
  })
}
