import type { Team, TeamMember, TeamOrchestration } from "@cognia/agent-config-types"
import { getDb } from "./schema"

function newId() {
  return "team_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export const TEAM_ORCHESTRATIONS: TeamOrchestration[] = [
  "mention_round_robin",
  "round_robin",
  "manual",
  "supervisor",
]

export async function listTeams(): Promise<Team[]> {
  return getDb().teams.orderBy("name").toArray()
}

export async function getTeam(id: string): Promise<Team | undefined> {
  return getDb().teams.get(id)
}

export type TeamDraft = Pick<Team, "name" | "members"> &
  Partial<
    Pick<
      Team,
      | "description"
      | "avatarColor"
      | "avatarEmoji"
      | "orchestration"
      | "maxResponses"
      | "supervisorCharacterId"
      | "mcpServerIds"
    >
  >

function validateOrchestration(
  orchestration: TeamOrchestration,
  members: TeamMember[],
  supervisorCharacterId: string | undefined
): void {
  if (orchestration !== "supervisor") return
  if (!supervisorCharacterId) {
    throw new Error("Supervisor mode requires a designated supervisor.")
  }
  if (!members.some((m) => m.characterId === supervisorCharacterId)) {
    throw new Error("The supervisor must be one of the team's members.")
  }
}

function validateMaxResponses(maxResponses: number | undefined): void {
  if (
    maxResponses !== undefined &&
    (!Number.isInteger(maxResponses) || maxResponses < 1 || maxResponses > 12)
  ) {
    throw new Error("Team response cap must be an integer from 1 through 12.")
  }
}

export async function createTeam(draft: TeamDraft): Promise<Team> {
  if (!draft.members || draft.members.length === 0) {
    throw new Error("A team needs at least one member.")
  }
  const orchestration = draft.orchestration ?? "mention_round_robin"
  const members = draft.members.map((m) => ({ ...m }))
  validateOrchestration(orchestration, members, draft.supervisorCharacterId)
  validateMaxResponses(draft.maxResponses)
  const now = Date.now()
  const team: Team = {
    id: newId(),
    name: draft.name.trim() || "Untitled team",
    description: draft.description,
    avatarColor: draft.avatarColor ?? "oklch(0.7 0.15 200)",
    avatarEmoji: draft.avatarEmoji,
    members,
    orchestration,
    maxResponses: draft.maxResponses,
    supervisorCharacterId: draft.supervisorCharacterId,
    mcpServerIds: draft.mcpServerIds,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().teams.put(team)
  return team
}

export async function updateTeam(
  id: string,
  patch: Partial<Omit<Team, "id" | "createdAt" | "isBuiltIn">>
): Promise<void> {
  if (patch.members && patch.members.length === 0) {
    throw new Error("A team needs at least one member.")
  }
  // When the caller is changing orchestration / members / supervisor we need
  // the resulting combination to remain consistent. Read the existing row,
  // merge the patch, and validate the result.
  const existing = await getDb().teams.get(id)
  if (!existing) throw new Error(`Team ${id} not found`)
  const nextOrchestration = patch.orchestration ?? existing.orchestration
  const nextMembers = patch.members ?? existing.members
  const nextSupervisor =
    "supervisorCharacterId" in patch ? patch.supervisorCharacterId : existing.supervisorCharacterId
  validateOrchestration(nextOrchestration, nextMembers, nextSupervisor)
  validateMaxResponses("maxResponses" in patch ? patch.maxResponses : existing.maxResponses)
  await getDb().teams.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteTeam(id: string): Promise<void> {
  const existing = await getDb().teams.get(id)
  if (existing?.isBuiltIn) {
    throw new Error("Built-in teams cannot be deleted. Duplicate first.")
  }
  await getDb().teams.delete(id)
}

export async function duplicateTeam(id: string): Promise<Team> {
  const source = await getDb().teams.get(id)
  if (!source) throw new Error(`Team ${id} not found`)
  const now = Date.now()
  const copy: Team = {
    ...source,
    id: newId(),
    name: `${source.name} (copy)`,
    members: source.members.map((m) => ({ ...m })),
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().teams.put(copy)
  return copy
}

/** Append `characterId` to the team's members if it isn't already present. */
export async function addMember(teamId: string, characterId: string): Promise<void> {
  const team = await getDb().teams.get(teamId)
  if (!team) throw new Error(`Team ${teamId} not found`)
  if (team.members.some((m) => m.characterId === characterId)) return
  await updateTeam(teamId, {
    members: [...team.members, { characterId }],
  })
}

/**
 * Drop `characterId` from the team. Refuses to remove the last member. If the
 * removed member was acting as supervisor the supervisor reference is cleared.
 */
export async function removeMember(teamId: string, characterId: string): Promise<void> {
  const team = await getDb().teams.get(teamId)
  if (!team) throw new Error(`Team ${teamId} not found`)
  const next = team.members.filter((m) => m.characterId !== characterId)
  if (next.length === 0) {
    throw new Error("Cannot remove the last member of a team.")
  }
  const patch: Partial<Team> = { members: next }
  if (team.supervisorCharacterId === characterId) {
    patch.supervisorCharacterId = undefined
    // If we were in supervisor mode and just removed the supervisor, fall back
    // to mention_round_robin so the team remains usable.
    if (team.orchestration === "supervisor") {
      patch.orchestration = "mention_round_robin"
    }
  }
  await updateTeam(teamId, patch)
}

/**
 * Replace the member order outright. Preserves any per-member overrides for
 * ids that remain in the new ordering. Ids missing from the existing roster
 * are added as plain `{ characterId }` slots.
 */
export async function reorderMembers(teamId: string, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) {
    throw new Error("A team needs at least one member.")
  }
  const team = await getDb().teams.get(teamId)
  if (!team) throw new Error(`Team ${teamId} not found`)
  const byId = new Map(team.members.map((m) => [m.characterId, m]))
  const next = orderedIds.map((cid) => byId.get(cid) ?? ({ characterId: cid } satisfies TeamMember))
  await updateTeam(teamId, { members: next })
}

/** Patch a single member's override fields. Unknown member ids are ignored. */
export async function updateMemberOverride(
  teamId: string,
  characterId: string,
  patch: Partial<Omit<TeamMember, "characterId">>
): Promise<void> {
  const team = await getDb().teams.get(teamId)
  if (!team) throw new Error(`Team ${teamId} not found`)
  let changed = false
  const next = team.members.map((m) => {
    if (m.characterId !== characterId) return m
    changed = true
    return { ...m, ...patch }
  })
  if (!changed) return
  await updateTeam(teamId, { members: next })
}

export async function seedBuiltInTeams(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const builtIns: Team[] = [
    {
      id: "team_builtin_brainstorm",
      name: "Brainstorm Squad",
      description: "A diverging-converging group: ideas, evidence, polish.",
      avatarColor: "oklch(0.74 0.16 90)",
      avatarEmoji: "🧠",
      members: [
        { characterId: "char_builtin_brainstorm" },
        { characterId: "char_builtin_research" },
        { characterId: "char_builtin_writer" },
      ],
      orchestration: "mention_round_robin",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "team_builtin_research_squad",
      name: "Research Squad",
      description:
        "Research-led inquiry: a senior researcher coordinates an idea-generator and a documenter.",
      avatarColor: "oklch(0.7 0.16 200)",
      avatarEmoji: "🔬",
      members: [
        { characterId: "char_builtin_research", role: "Lead researcher" },
        { characterId: "char_builtin_brainstorm", role: "Idea generator" },
        { characterId: "char_builtin_writer", role: "Documenter" },
      ],
      orchestration: "supervisor",
      supervisorCharacterId: "char_builtin_research",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "team_builtin_doc_polishers",
      name: "Doc Polishers",
      description: "Drafts, fact-checks, and translates documentation in one pass.",
      avatarColor: "oklch(0.7 0.13 150)",
      avatarEmoji: "📝",
      members: [
        { characterId: "char_builtin_writer", role: "Drafter" },
        { characterId: "char_builtin_research", role: "Fact-checker" },
        { characterId: "char_builtin_translator", role: "Localizer" },
      ],
      orchestration: "mention_round_robin",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "team_builtin_code_review_pair",
      name: "Code Review Pair",
      description:
        "A coding lead drives the review; a research backstop pulls supporting evidence.",
      avatarColor: "oklch(0.65 0.18 245)",
      avatarEmoji: "👨‍💻",
      members: [
        { characterId: "char_builtin_coding", role: "Reviewer" },
        { characterId: "char_builtin_research", role: "Evidence" },
      ],
      orchestration: "supervisor",
      supervisorCharacterId: "char_builtin_coding",
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
  await db.teams.bulkPut(builtIns)
}
