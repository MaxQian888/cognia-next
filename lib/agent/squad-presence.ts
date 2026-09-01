/**
 * What a Squad is doing right now, derived once and read in two places.
 *
 * `/squads` computed this inline: which Squads belong to the active workspace,
 * how many teammates each has, which are blocked on a human, and the sort that
 * puts the actionable ones first. The composer's executor picker computed none
 * of it, so the control that BINDS a conversation to a Squad listed nothing but
 * names, while the page that only reports on Squads had the whole picture. Two
 * surfaces, one question, and the one where the decision is made knew less.
 *
 * Pure by design. It takes the store's own record shapes rather than reaching
 * into zustand, so it runs in the fast node Jest project and neither consumer
 * has to own the derivation.
 */

/**
 * Statuses that mean "this Squad is doing something right now".
 *
 * `planning` and `executing` only. `paused` is a Squad someone stopped, and
 * showing it as live is how a fleet view starts lying about what needs
 * attention.
 */
export const LIVE_SQUAD_STATUSES: ReadonlySet<string> = new Set(["planning", "executing"])

export function isLiveSquadStatus(status: string | undefined): boolean {
  return status !== undefined && LIVE_SQUAD_STATUSES.has(status)
}

/** The subset of `AgentTeam` this derivation reads. */
export interface SquadPresenceTeam {
  id: string
  name: string
  description?: string
  status: string
  projectId?: string
}

/** The subset of `AgentTeammate` this derivation reads. */
export interface SquadPresenceMember {
  teamId: string
}

/** The subset of `PendingGate` this derivation reads. */
export interface SquadPresenceGate {
  teamId?: string
  status: string
}

export interface SquadPresenceRow {
  id: string
  name: string
  description?: string
  status: string
  memberCount: number
  /** Planning or executing. */
  live: boolean
  /** Holding a run open on a human answer. */
  waiting: boolean
}

export interface CollectSquadPresenceInput {
  teams: Readonly<Record<string, SquadPresenceTeam>>
  teammates: Readonly<Record<string, SquadPresenceMember>>
  /** Open approval gates. Only `status === "open"` counts as waiting. */
  gates?: readonly SquadPresenceGate[]
  /**
   * Scope to one workspace.
   *
   * A Squad with no `projectId` is SHARED, not foreign, so it passes every
   * filter. `createTeam` stamps the active project and the store purges per
   * project, which is why a Squad belonging to a different workspace is noise.
   * Pass `null` or omit to skip the filter entirely.
   */
  workspaceId?: string | null
}

/**
 * Every Squad worth offering, annotated and ordered.
 *
 * The sort is the interesting part and it is not alphabetical. A fleet view is
 * read to find what needs YOU: a Squad blocked on an approval will not move
 * until it is answered, so burying it under an alphabetically earlier idle
 * Squad hides the only actionable row on the surface. Waiting first, then
 * working, then by name.
 */
export function collectSquadPresence({
  teams,
  teammates,
  gates = [],
  workspaceId = null,
}: CollectSquadPresenceInput): SquadPresenceRow[] {
  const waitingIds = new Set<string>()
  for (const gate of gates) {
    if (gate.status === "open" && gate.teamId) waitingIds.add(gate.teamId)
  }

  const memberCounts = new Map<string, number>()
  for (const member of Object.values(teammates)) {
    memberCounts.set(member.teamId, (memberCounts.get(member.teamId) ?? 0) + 1)
  }

  return Object.values(teams)
    .filter((team) => !workspaceId || !team.projectId || team.projectId === workspaceId)
    .map((team) => ({
      id: team.id,
      name: team.name,
      ...(team.description === undefined ? {} : { description: team.description }),
      status: team.status,
      memberCount: memberCounts.get(team.id) ?? 0,
      live: isLiveSquadStatus(team.status),
      waiting: waitingIds.has(team.id),
    }))
    .sort((a, b) => {
      const wait = Number(b.waiting) - Number(a.waiting)
      if (wait !== 0) return wait
      const live = Number(b.live) - Number(a.live)
      if (live !== 0) return live
      return a.name.localeCompare(b.name)
    })
}
