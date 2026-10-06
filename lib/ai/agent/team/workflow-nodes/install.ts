/**
 * Install the Agent Team's workflow node implementations into the workflow
 * engine's port (ADR-0217). Hosts call this from their composition root
 * before they run workflows; the team lifecycle calls it before it runs a
 * synthesized team workflow. Idempotent: the loader is one stable function.
 */

import { installTeamWorkflowNodes } from "@/lib/workflow/nodes/teams/team-runtime-port"
import {
  registerRunRecoveryOwner,
  type RunRecoveryOwner,
} from "@/lib/workflow/runtime/resume-controller"
import { isTeamWorkflowId } from "../team-workflow-id"

const loadTeamWorkflowNodeImplementations = () =>
  import("./index").then((module) => module.teamWorkflowNodes)
const resolveTeamKnowledgeDependencies = (teamId: string) =>
  import("./index").then((module) => module.resolveTeamKnowledgeBaseIds(teamId))

/**
 * Synthesized team runs are recovered by the team's durable coordinator
 * (squad bootstrap → `recoverDurableAgentTeams`), which re-registers the team
 * run context first. Workflow resume must not replay them on its own.
 */
const teamRunRecoveryOwner: RunRecoveryOwner = {
  id: "agent-team",
  owns: (row) =>
    isTeamWorkflowId(row.workflowId) ||
    (typeof row.snapshot?.id === "string" && isTeamWorkflowId(row.snapshot.id)),
}

export function installTeamWorkflowNodeRuntime(): void {
  installTeamWorkflowNodes(loadTeamWorkflowNodeImplementations, resolveTeamKnowledgeDependencies)
  registerRunRecoveryOwner(teamRunRecoveryOwner)
}
