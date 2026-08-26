/**
 * Agent Team's delivery graph: many repositories, one approval, remediation
 * between the checks and the merge.
 *
 * # Why this is not `lib/stack`
 *
 * They look alike and are not the same thing. A `Stack` is one repository's
 * chain of branches, with git as the truth and a restack as the repair. This is
 * a run's whole delivery: several repositories that depend on each other, node
 * state persisted so a half-finished merge can be resumed, an approval gate,
 * and a remediation loop that hands a failing layer back to an agent. None of
 * that belongs in the single-repository engine, and folding this into
 * `mergeStack` would drop all four.
 *
 * What IS shared is shared: the ordering rule (`lib/stack/topology`), the base
 * chain (`lib/stack/model`), and — before anything is published — the ancestry
 * check in {@link assertPublishableStack}, because "these branches finished in
 * this order" and "these branches are a stack" are different claims and only
 * git can settle the second.
 */

import {
  listAgentTeamDeliveryNodes,
  putAgentTeamDeliveryGraph,
  putAgentTeamDeliveryNodes,
} from "@/lib/db/agent-team-runtime"
import { getDb } from "@/lib/db/schema"
import { baseBranches } from "@/lib/stack/model"
import { topologicalOrder } from "@/lib/stack/topology"
import type {
  AgentTeamDeliveryGraph,
  AgentTeamDeliveryNode,
} from "@/types/agent/agent-team-runtime"

export interface ScmDeliveryObservation {
  ci: "unknown" | "pending" | "passing" | "failing"
  approved: boolean
  mergeable: boolean
  conflict: boolean
}

export interface ScmDeliveryAdapter {
  createPullRequest(input: {
    repositoryId: string
    branch: string
    baseBranch: string
    title: string
    order: number
  }): Promise<{ number: number; url: string; headSha: string }>
  observe(node: AgentTeamDeliveryNode): Promise<ScmDeliveryObservation>
  retarget(node: AgentTeamDeliveryNode, baseBranch: string): Promise<void>
  updateBranch(node: AgentTeamDeliveryNode): Promise<void>
  merge(node: AgentTeamDeliveryNode): Promise<void>
}

export interface CreateDeliveryGraphInput {
  id: string
  runId: string
  repositories: Array<{
    repositoryId: string
    baseBranch: string
    dependsOn?: string[]
    layers: Array<{ id: string; branch: string; title: string; dependsOn?: string[] }>
  }>
}

export interface DeliveryGraphServiceOptions {
  adapter?: ScmDeliveryAdapter
  remediate?: (
    node: AgentTeamDeliveryNode,
    observation: ScmDeliveryObservation,
    attempt: number
  ) => Promise<void>
  maxRemediationAttempts?: number
  now?: () => number
}

/**
 * Delivery order, from the shared implementation in `lib/stack/topology`.
 *
 * The ordering rule — dependencies first, ties broken by `order` then by
 * repository — is not specific to Agent Team; a stack of pull requests needs
 * exactly the same one. Identity is preserved through the id lookup because
 * `publish` mutates the node objects it is handed.
 */
function topological(nodes: AgentTeamDeliveryNode[]): AgentTeamDeliveryNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return topologicalOrder(
    nodes.map((node) => ({
      id: node.id,
      dependsOn: node.dependsOn,
      order: node.order,
      tieBreaker: node.repositoryId,
    }))
  ).map((entry) => byId.get(entry.id) as AgentTeamDeliveryNode)
}

export function createDeliveryGraphService(options: DeliveryGraphServiceOptions) {
  const now = options.now ?? Date.now

  const loadGraph = async (graphId: string): Promise<AgentTeamDeliveryGraph> => {
    const graph = await getDb().agentTeamDeliveryGraphs.get(graphId)
    if (!graph) throw new Error(`Unknown AgentTeam delivery graph: ${graphId}`)
    return graph
  }

  return {
    async create(input: CreateDeliveryGraphInput): Promise<AgentTeamDeliveryGraph> {
      if (input.repositories.length === 0) throw new Error("Delivery graph requires a repository")
      const createdAt = now()
      const nodes: AgentTeamDeliveryNode[] = []
      const repositoryLast = new Map(
        input.repositories.map((repository) => [
          repository.repositoryId,
          repository.layers[repository.layers.length - 1]?.id,
        ])
      )
      for (const repository of input.repositories) {
        if (repository.layers.length < 2 || repository.layers.length > 100) {
          throw new Error("A repository delivery stack must contain 2 to 100 layers")
        }
        const bases = baseBranches({
          trunk: repository.baseBranch,
          layers: repository.layers.map((layer, index) => ({
            id: layer.id,
            branch: layer.branch,
            title: layer.title,
            order: index,
          })),
        })
        repository.layers.forEach((layer, index) => {
          if (nodes.some((node) => node.id === layer.id)) {
            throw new Error(`Duplicate delivery node id: ${layer.id}`)
          }
          const previous = index > 0 ? repository.layers[index - 1]!.id : undefined
          const crossRepository =
            index === 0
              ? (repository.dependsOn ?? []).map((repositoryId) => {
                  const dependency = repositoryLast.get(repositoryId)
                  if (!dependency) throw new Error(`Unknown repository dependency: ${repositoryId}`)
                  return dependency
                })
              : []
          nodes.push({
            id: layer.id,
            graphId: input.id,
            runId: input.runId,
            repositoryId: repository.repositoryId,
            title: layer.title,
            order: index,
            dependsOn: [
              ...crossRepository,
              ...(previous ? [previous] : []),
              ...(layer.dependsOn ?? []),
            ],
            branch: layer.branch,
            // The same rule the stack engine applies, from the same function:
            // two copies of "layer n is based on layer n-1" is two places for
            // an off-by-one to live.
            baseBranch: bases.get(layer.branch) ?? repository.baseBranch,
            status: "blocked",
            createdAt,
            updatedAt: createdAt,
          })
        })
      }
      topological(nodes)
      const graph: AgentTeamDeliveryGraph = {
        id: input.id,
        runId: input.runId,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      }
      await putAgentTeamDeliveryGraph(graph)
      await putAgentTeamDeliveryNodes(nodes)
      return graph
    },

    async publish(graphId: string): Promise<AgentTeamDeliveryNode[]> {
      if (!options.adapter) throw new Error("Publishing a delivery graph requires an SCM adapter")
      const graph = await loadGraph(graphId)
      if (graph.status !== "draft") throw new Error("Only draft delivery graphs can publish")
      const nodes = topological(await listAgentTeamDeliveryNodes(graphId))
      for (const node of nodes) {
        const created = await options.adapter.createPullRequest({
          repositoryId: node.repositoryId,
          branch: node.branch,
          baseBranch: node.baseBranch,
          title: node.title,
          order: node.order,
        })
        Object.assign(node, {
          pullRequestNumber: created.number,
          pullRequestUrl: created.url,
          headSha: created.headSha,
          status: "ci_pending" as const,
          updatedAt: now(),
        })
        await getDb().agentTeamDeliveryNodes.put(node)
      }
      await getDb().agentTeamDeliveryGraphs.update(graphId, { status: "running", updatedAt: now() })
      return nodes
    },

    async approve(graphId: string): Promise<void> {
      const graph = await loadGraph(graphId)
      if (graph.status !== "running" && graph.status !== "awaiting_approval") {
        throw new Error("Delivery graph is not ready for approval")
      }
      const at = now()
      await getDb().agentTeamDeliveryGraphs.update(graphId, {
        status: "awaiting_approval",
        approvedAt: at,
        updatedAt: at,
      })
    },

    async merge(graphId: string): Promise<AgentTeamDeliveryGraph> {
      if (!options.adapter) throw new Error("Merging a delivery graph requires an SCM adapter")
      const graph = await loadGraph(graphId)
      if (!graph.approvedAt) throw new Error("Delivery graph requires user approval before merge")
      const nodes = topological(await listAgentTeamDeliveryNodes(graphId))
      const rootBases = new Map<string, string>()
      for (const node of nodes) {
        if (node.order === 0) rootBases.set(node.repositoryId, node.baseBranch)
      }
      for (const node of nodes) {
        if (node.order > 0) {
          const rootBase = rootBases.get(node.repositoryId)
          if (!rootBase) throw new Error(`Missing root base for repository ${node.repositoryId}`)
          await options.adapter.retarget(node, rootBase)
          await options.adapter.updateBranch(node)
          node.baseBranch = rootBase
        }
        let observation = await options.adapter.observe(node)
        let remediationAttempt = 0
        while (
          options.remediate &&
          remediationAttempt < (options.maxRemediationAttempts ?? 1) &&
          (observation.ci !== "passing" ||
            observation.conflict ||
            !observation.mergeable ||
            !observation.approved)
        ) {
          remediationAttempt += 1
          await getDb().agentTeamDeliveryNodes.update(node.id, {
            status: "needs_remediation",
            updatedAt: now(),
          })
          await options.remediate(node, observation, remediationAttempt)
          await options.adapter.updateBranch(node)
          observation = await options.adapter.observe(node)
        }
        if (observation.ci !== "passing") {
          await getDb().agentTeamDeliveryNodes.update(node.id, {
            status: "needs_remediation",
            error: "CI is not passing",
            updatedAt: now(),
          })
          await getDb().agentTeamDeliveryGraphs.update(graphId, {
            status: "failed",
            updatedAt: now(),
          })
          throw new Error(`Cannot merge ${node.id}: CI is not passing`)
        }
        if (observation.conflict || !observation.mergeable || !observation.approved) {
          await getDb().agentTeamDeliveryNodes.update(node.id, {
            status: "needs_remediation",
            error: observation.conflict ? "Merge conflict" : "PR is not approved and mergeable",
            updatedAt: now(),
          })
          await getDb().agentTeamDeliveryGraphs.update(graphId, {
            status: "failed",
            updatedAt: now(),
          })
          throw new Error(`Cannot merge ${node.id}: PR is not approved and mergeable`)
        }
        await options.adapter.merge(node)
        node.status = "merged"
        node.updatedAt = now()
        await getDb().agentTeamDeliveryNodes.put(node)
      }
      const completed: AgentTeamDeliveryGraph = { ...graph, status: "completed", updatedAt: now() }
      await getDb().agentTeamDeliveryGraphs.put(completed)
      return completed
    },
  }
}

export type DeliveryGraphService = ReturnType<typeof createDeliveryGraphService>
