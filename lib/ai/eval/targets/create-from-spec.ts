/**
 * Build an {@link EvalTarget} from a {@link TargetSpec} + the three target dep
 * sets. The run-config matrix calls this once per target variant.
 */

import type { TargetSpec } from "@/types/eval/run-config"
import type { EvalTarget } from "../runner"
import { createChatTarget, type ChatTargetDeps } from "./chat"
import { createTeamTarget, type TeamTargetDeps } from "./team"
import { createWorkflowTarget, type WorkflowTargetDeps } from "./workflow"

export interface TargetDepsBundle {
  chat: ChatTargetDeps
  team: TeamTargetDeps
  workflow: WorkflowTargetDeps
}

export function createTargetFromSpec(spec: TargetSpec, deps: TargetDepsBundle): EvalTarget {
  switch (spec.kind) {
    case "chat":
      return createChatTarget(
        {
          label: spec.label,
          ...(spec.providerId ? { providerId: spec.providerId } : {}),
          model: spec.model,
          ...(spec.characterId ? { characterId: spec.characterId } : {}),
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
          ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        },
        deps.chat
      )
    case "team":
      return createTeamTarget(
        {
          label: spec.label,
          teamId: spec.teamId,
          ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        },
        deps.team
      )
    case "workflow":
      return createWorkflowTarget(
        {
          label: spec.label,
          workflowId: spec.workflowId,
          ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        },
        deps.workflow
      )
    default: {
      const exhaustive: never = spec
      throw new Error(`createTargetFromSpec: unknown target kind ${JSON.stringify(exhaustive)}`)
    }
  }
}
