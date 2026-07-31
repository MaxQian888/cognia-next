/**
 * Team adapter for the risk classifier — projects an `AgentTeam` + its roster
 * onto the transport-agnostic `RiskInput` that `lib/policy/risk` consumes.
 *
 * This is the only file that knows both shapes: the policy layer stays free of
 * Agent Team types (so /goal and Workflow can feed it their own adapters in
 * later phases), and the runtime stays free of capability-resolution details.
 *
 * Pure + synchronous — capability resolution goes through
 * `capability-resolver.ts` (no registry lookups, no I/O), so the whole
 * pre-run risk assessment costs nothing and is trivially testable. Per ADR-0070.
 */

import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import type { RiskInput } from "@/lib/policy/risk/classify-risk"
import { resolveTeammateCapabilities } from "./capability-resolver"

export interface BuildTeamRiskInputParams {
  team: AgentTeam
  /** The workers that will actually be dispatched (the lead plans, it doesn't act). */
  workers: AgentTeammate[]
  /** The tasks this run will dispatch (post `taskFilter` on a resume). */
  tasks: AgentTeamTask[]
}

/**
 * Build the classifier input for a team run.
 *
 * Tool ids union each worker's explicit `tools` allowlist with its resolved
 * `nativeAnthropicToolIds` — a teammate can reach a native tool through the
 * team's capability bundle without ever naming it in `tools`, so reading only
 * one of the two would under-report. Sandbox posture is an OR across the team
 * default and every worker override, matching `teammateToCharacter`'s resolution:
 * one unsandboxed worker means the run is unsandboxed.
 */
export function buildTeamRiskInput({ team, workers, tasks }: BuildTeamRiskInputParams): RiskInput {
  const toolIds = new Set<string>()
  const capabilityIds = new Set<string>()
  let sandboxEnabled = team.config.sandboxEnabled === true

  for (const worker of workers) {
    for (const id of worker.config.tools ?? []) toolIds.add(id)

    const caps = resolveTeammateCapabilities(team, worker)
    for (const id of caps.nativeAnthropicToolIds) toolIds.add(id)
    for (const id of [
      ...caps.mcpServerIds,
      ...caps.skillIds,
      ...caps.subagentIds,
      ...caps.externalAgentPresetIds,
    ]) {
      capabilityIds.add(id)
    }

    // A teammate may enable the sandbox individually even when the team default
    // is unset — but it may not be *disabled* here, because the classifier only
    // downgrades on sandbox coverage and a partial roster has none.
    if (worker.config.sandboxEnabled === true) sandboxEnabled = true
  }

  // The team default only counts as coverage if no worker opted out of it.
  if (sandboxEnabled && workers.some((w) => w.config.sandboxEnabled === false)) {
    sandboxEnabled = false
  }

  return {
    objective: team.task ?? "",
    taskDescriptions: tasks.map((t) => t.description ?? "").filter(Boolean),
    toolIds: [...toolIds],
    capabilityIds: [...capabilityIds],
    sandboxEnabled,
  }
}
