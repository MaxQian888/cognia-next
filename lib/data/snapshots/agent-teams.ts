// Snapshot for `localStorage["cognia-agent-teams"]`. Distinct face from the
// Dexie `teams` table: this stores team templates / defaultConfig /
// displayMode / workspaceTab — the UI workspace layout for the multi-agent
// team feature. Both faces are backed up independently.

import { createGenericSnapshotModule } from "./factory"

export const AGENT_TEAMS_PERSIST_KEY = "cognia-agent-teams"
export const AGENT_TEAMS_LABEL_KEY = "agentTeams"

export const agentTeamsSnapshot = createGenericSnapshotModule({
  key: AGENT_TEAMS_PERSIST_KEY,
  labelKey: AGENT_TEAMS_LABEL_KEY,
  exposeAsDomain: true,
  maxBytesWarn: 500_000,
})
