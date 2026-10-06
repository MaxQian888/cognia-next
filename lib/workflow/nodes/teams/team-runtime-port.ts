/**
 * The port the Agent Team's workflow nodes run through (ADR-0217).
 *
 * The workflow engine registers the team node kinds (so every host knows them
 * and `executor-coverage.test.ts` stays honest) but does not import team code.
 * The team side installs its implementations here; a host that runs workflows
 * installs them from its composition root, and the team lifecycle installs
 * them before it runs a synthesized team workflow. A node that runs before
 * anything was installed fails with a non-retryable error naming the cause,
 * instead of the workflow engine reaching into the team runtime itself.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { nonRetryable } from "../shared/executor-support"

type TeamNodeExecutor = (ctx: StepExecutionContext) => Promise<StepExecutionResult>

/** One implementation per team node kind. */
export interface TeamWorkflowNodes {
  /** `action.team.run` */
  run: TeamNodeExecutor
  /** `action.team.task.dispatch` */
  dispatchTask: TeamNodeExecutor
  /** `action.team.task.review` */
  reviewTask: TeamNodeExecutor
  /** `action.team.reconcile` */
  reconcile: TeamNodeExecutor
  /** `action.team.compose` */
  compose: TeamNodeExecutor
  /** `action.team.status` */
  status: TeamNodeExecutor
  /** `action.team.delegate` */
  delegate: TeamNodeExecutor
  /** `action.team.message` */
  message: TeamNodeExecutor
}

type TeamWorkflowNodesLoader = () => Promise<TeamWorkflowNodes>
type TeamKnowledgeDependencyResolver = (teamId: string) => Promise<readonly string[]>

let loader: TeamWorkflowNodesLoader | null = null
let loaded: Promise<TeamWorkflowNodes> | null = null
let knowledgeDependencies: TeamKnowledgeDependencyResolver | undefined

/**
 * Install the team node implementations. Idempotent for the same loader; a
 * different loader replaces the previous one (tests, host reconfiguration).
 */
export function installTeamWorkflowNodes(
  load: TeamWorkflowNodesLoader,
  resolveKnowledgeDependencies?: TeamKnowledgeDependencyResolver
): void {
  if (loader === load && knowledgeDependencies === resolveKnowledgeDependencies) return
  loader = load
  loaded = null
  knowledgeDependencies = resolveKnowledgeDependencies
}

/** Static team knowledge is discovered at admission; legacy hosts grant no extra scope. */
export async function resolveTeamWorkflowKnowledgeBaseIds(
  teamId: string
): Promise<readonly string[]> {
  if (!loader) await loadTeamWorkflowNodes("action.team.run admission")
  return knowledgeDependencies ? knowledgeDependencies(teamId) : []
}

/** Whether a host has installed the team node implementations. */
export function hasTeamWorkflowNodes(): boolean {
  return loader !== null
}

/** Resolve the installed implementations, or fail the node explaining why. */
export async function loadTeamWorkflowNodes(kind: string): Promise<TeamWorkflowNodes> {
  if (!loader) {
    throw nonRetryable(
      `${kind}: the Agent Team runtime is not installed on this host, so team nodes cannot run here`
    )
  }
  if (!loaded) {
    const pending = loader()
    loaded = pending
    // A failed load (chunk error) must not poison every later attempt.
    pending.catch(() => {
      if (loaded === pending) loaded = null
    })
  }
  return loaded
}

/** Test seam: forget any installed implementation. */
export function __resetTeamWorkflowNodesForTesting(): void {
  loader = null
  loaded = null
  knowledgeDependencies = undefined
}
