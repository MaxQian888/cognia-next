import { AGENT_TEAMS_LABEL_KEY, AGENT_TEAMS_PERSIST_KEY, agentTeamsSnapshot } from "./agent-teams"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("agentTeamsSnapshot", () => {
  it("declares persist + label keys", () => {
    expect(agentTeamsSnapshot.key).toBe(AGENT_TEAMS_PERSIST_KEY)
    expect(agentTeamsSnapshot.labelKey).toBe(AGENT_TEAMS_LABEL_KEY)
    expect(agentTeamsSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures the partialized template/defaultConfig/displayMode shape", () => {
    const payload = {
      state: {
        templates: { team1: { id: "team1", name: "Trio" } },
        defaultConfig: { agents: ["a", "b"] },
        displayMode: "grid",
        workspaceTab: "all",
      },
      version: 1,
    }
    const { storage } = createMemoryStorage({
      [AGENT_TEAMS_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(agentTeamsSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })

  it("returns null when missing", () => {
    const { storage } = createMemoryStorage()
    const env: SnapshotEnv = { storage }
    expect(agentTeamsSnapshot.read(env)).toBeNull()
  })

  it("respects skip strategy when an entry already exists", () => {
    const { storage, data } = createMemoryStorage({
      [AGENT_TEAMS_PERSIST_KEY]: JSON.stringify({ state: { keep: 1 }, version: 1 }),
    })
    const env: SnapshotEnv = { storage }
    agentTeamsSnapshot.write(
      {
        key: AGENT_TEAMS_PERSIST_KEY,
        storeVersion: 1,
        snapshotFormatVersion: 1,
        raw: { state: { dropped: true }, version: 1 },
        capturedAt: "2024-01-01T00:00:00.000Z",
      },
      "skip",
      env
    )
    expect(data.get(AGENT_TEAMS_PERSIST_KEY)).toContain('"keep":1')
  })
})
