/**
 * The `__team__:` workflow-id format — one owner for the string.
 *
 * A team run does not have a stored workflow DEFINITION: the synthesizers
 * (`synthesize-workflow.ts`, `synthesize-ultracode.ts`) mint a throwaway
 * `VisualWorkflow` per run and the full snapshot lives on the `workflowRuns`
 * row. The id carries the team it belongs to so the run can be found again
 * (`useTeamLiveStatus` does a Dexie `startsWith` on it) and so the UI knows not
 * to try loading a definition for it.
 *
 * `types/agent-runs/agent-run.ts` used to hold a parser that CLAIMED to be the
 * single source of truth while every producer kept its own literal — the claim
 * was untrue for as long as it stood. This module is the real one: both
 * producers call {@link buildTeamWorkflowId} and the only consumer calls
 * {@link teamWorkflowIdPrefix}, so nothing can build or match the format
 * without going through here. Pinned by `team-workflow-id.test.ts`.
 *
 * Pure module — no Dexie / React imports.
 */

import { nanoid } from "nanoid"

/** Leading marker on every synthesized team-run workflow id. */
export const TEAM_WORKFLOW_ID_PREFIX = "__team__:"

/** Length of the per-run nonce that makes a re-run of the same team distinct. */
const TEAM_WORKFLOW_ID_NONCE_LENGTH = 8

/**
 * Mint a fresh id for one team run: `__team__:<teamId>:<nonce>`. The nonce is
 * what separates repeat runs of the same team, so it is generated here rather
 * than passed in — the whole format lives in this function.
 */
export function buildTeamWorkflowId(teamId: string): string {
  return `${TEAM_WORKFLOW_ID_PREFIX}${teamId}:${nanoid(TEAM_WORKFLOW_ID_NONCE_LENGTH)}`
}

/**
 * The `__team__:<teamId>:` string that every run of one team starts with —
 * built for Dexie `where("workflowId").startsWith(...)` lookups. Includes the
 * trailing separator so `team-1` cannot match `team-10`'s runs.
 */
export function teamWorkflowIdPrefix(teamId: string): string {
  return `${TEAM_WORKFLOW_ID_PREFIX}${teamId}:`
}

/** Whether a workflow id belongs to a synthesized team run. */
export function isTeamWorkflowId(workflowId: string): boolean {
  return workflowId.startsWith(TEAM_WORKFLOW_ID_PREFIX)
}

/**
 * Split a team workflow id back into its parts, or `null` when the id is not a
 * team id (a plain workflow id) or carries no team segment.
 */
export function parseTeamWorkflowId(workflowId: string): { teamId: string; nonce: string } | null {
  if (!isTeamWorkflowId(workflowId)) return null
  const rest = workflowId.slice(TEAM_WORKFLOW_ID_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator < 0) return rest ? { teamId: rest, nonce: "" } : null
  const teamId = rest.slice(0, separator)
  if (!teamId) return null
  return { teamId, nonce: rest.slice(separator + 1) }
}

/**
 * Whether a `trigger.team` workflow-run row is one of THIS team's synthesized
 * runs. Synthesized team runs stamp exactly `{ teamId }`; user workflows
 * started by the "on team finished" fan-out share the trigger kind but carry
 * `event: "team.completed"`. Lived in the retired `TeamRunsList`; kept here
 * for the history backfill and the CLI projection, which apply the same rule.
 */
export function isSynthesizedTeamRunPayload(payload: unknown, teamId: string): boolean {
  const p = payload as { teamId?: string; event?: string } | undefined
  return p?.teamId === teamId && p?.event === undefined
}
