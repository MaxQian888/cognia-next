/**
 * Translate an ultracode plan into a runnable VisualWorkflow of `pattern.*`
 * nodes (ADR-0022 addendum). Sibling to `synthesize-workflow.ts`: pure (no
 * Dexie / no dispatch), shapes types only, and emits the same `__team__:` id
 * prefix so the UI never tries to load a definition for it.
 *
 * Wiring rule (forward-only DAG, Kahn-validated by construction):
 *  - sweep / loop nodes accumulate into the current "finding sources".
 *  - a verify node depends on all current finding sources; afterwards its
 *    survivors REPLACE them as the finding source.
 *  - a critic node depends on the current finding sources (reads, doesn't
 *    consume).
 *  - a judge node is independent (produces a winner from the objective).
 *  - the terminal synthesize node fans in from EVERY prior node so it sees
 *    findings, winner, and gaps at once. A synthesize stage is appended if the
 *    plan omits one.
 */

import { nanoid } from "nanoid"
import type { AgentTeam } from "@/types/agent/agent-team"
import {
  VERIFIER_LENSES,
  type UltracodePlan,
  type UltracodeStage,
  type VerifierLens,
} from "@/types/agent/ultracode"
import { DEFAULT_RETRY_POLICY } from "@/types/workflow/visual"
import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"

export interface SynthesizeUltracodeInput {
  team: AgentTeam
  plan: UltracodePlan
  initialConcurrency: number
  wallClockTimeoutMs?: number
}

export interface SynthesizeUltracodeResult {
  workflow: VisualWorkflow
  /** The terminal synthesize node id; its output becomes `team.finalResult`. */
  terminalNodeId: string
}

function isVerifierLens(v: string): v is VerifierLens {
  return (VERIFIER_LENSES as readonly string[]).includes(v)
}

function stageParams(
  stage: UltracodeStage,
  team: AgentTeam,
  objective: string
): Record<string, unknown> {
  const uc = team.config.ultracode ?? {}
  const base = { teamId: team.id, objective }
  switch (stage.pattern) {
    case "multi-modal-sweep":
      return {
        ...base,
        modalities:
          stage.variants && stage.variants.length > 0 ? stage.variants : [stage.instruction],
      }
    case "loop-until-dry":
      return {
        ...base,
        finderPrompt: stage.instruction,
        dryRoundsToStop: uc.dryRoundsToStop ?? 2,
        maxRounds: uc.maxFinderRounds ?? 4,
        findersPerRound: stage.count ?? 1,
      }
    case "adversarial-verify": {
      const lenses = (stage.variants ?? []).filter(isVerifierLens)
      return {
        ...base,
        skepticsPerFinding: stage.count ?? uc.skepticsPerFinding ?? 3,
        ...(lenses.length > 0 ? { lenses } : {}),
      }
    }
    case "judge-panel":
      return {
        ...base,
        angles: stage.variants && stage.variants.length > 0 ? stage.variants : [stage.instruction],
        judgesPerAttempt: stage.count ?? uc.judgesPerAttempt ?? 3,
      }
    case "completeness-critic":
    case "synthesize":
      return base
  }
}

export function synthesizeUltracodeWorkflow(
  input: SynthesizeUltracodeInput
): SynthesizeUltracodeResult {
  const objective = input.team.task?.trim() || input.team.description?.trim() || input.team.name

  // Ensure a terminal synthesize stage.
  const stages: UltracodeStage[] = [...input.plan.stages]
  if (stages[stages.length - 1]?.pattern !== "synthesize") {
    stages.push({ pattern: "synthesize", instruction: "Synthesize the final cited report." })
  }

  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []
  const addEdge = (source: string, target: string): void => {
    edges.push({ id: `${source}->${target}`, source, target } as WorkflowEdge)
  }

  let findingSources: string[] = []
  let terminalNodeId = ""

  stages.forEach((stage, i) => {
    const nodeId = `p${i}_${stage.pattern}`
    nodes.push({
      id: nodeId,
      type: `pattern.${stage.pattern}`,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: {
        label: stage.instruction.slice(0, 60),
        params: stageParams(stage, input.team, objective),
      },
    } as WorkflowNode)

    switch (stage.pattern) {
      case "multi-modal-sweep":
      case "loop-until-dry":
        findingSources.push(nodeId)
        break
      case "adversarial-verify":
        for (const src of findingSources) addEdge(src, nodeId)
        findingSources = [nodeId] // survivors replace raw findings
        break
      case "completeness-critic":
        for (const src of findingSources) addEdge(src, nodeId)
        break
      case "judge-panel":
        // Independent of findings — produces a winner from the objective.
        break
      case "synthesize":
        // Fan in from everything emitted so far.
        for (const prior of nodes) {
          if (prior.id !== nodeId) addEdge(prior.id, nodeId)
        }
        terminalNodeId = nodeId
        break
    }
  })

  const wallClock =
    input.wallClockTimeoutMs && input.wallClockTimeoutMs > 0
      ? input.wallClockTimeoutMs
      : 24 * 60 * 60_000

  const now = Date.now()
  const workflow: VisualWorkflow = {
    id: `__team__:${input.team.id}:${nanoid(8)}`,
    schemaVersion: 1,
    name: `${input.team.name} — ultracode`,
    description: input.plan.summary,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    settings: {
      errorPolicy: "stop",
      timeoutMs: wallClock,
      concurrency: 1,
      maxConcurrency: Math.max(1, input.initialConcurrency),
      retryDefaults: DEFAULT_RETRY_POLICY,
    },
  }

  return { workflow, terminalNodeId }
}
