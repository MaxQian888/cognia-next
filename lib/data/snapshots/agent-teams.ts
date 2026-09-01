// Snapshot for `localStorage["cognia-agent-teams"]`.
//
// From persist v8 this is preferences only: squad templates (profile-shared by
// design), `defaultConfig`, `displayMode`, `workspaceTab`. The squads
// themselves, their roster and their tasks moved to Dexie (`agentTeams`,
// `agentTeammates`, `agentTeamTasks`, schema v215) and reach a backup through
// the table pipeline instead, which is what lets them carry a workspace and
// cross to a paired device.
//
// Note the Dexie `teams` table is a different feature entirely: Character Teams
// (persona guilds), not squads.

import { createGenericSnapshotModule } from "./factory"

export const AGENT_TEAMS_PERSIST_KEY = "cognia-agent-teams"
export const AGENT_TEAMS_LABEL_KEY = "agentTeams"

export const agentTeamsSnapshot = createGenericSnapshotModule({
  key: AGENT_TEAMS_PERSIST_KEY,
  labelKey: AGENT_TEAMS_LABEL_KEY,
  exposeAsDomain: true,
  maxBytesWarn: 500_000,
})
