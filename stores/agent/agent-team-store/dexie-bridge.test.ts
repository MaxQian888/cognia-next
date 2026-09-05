/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  loadAgentTeamDefinitions,
  writeAgentTeamDefinitions,
} from "@/lib/db/agent-team-definitions"
import type { AgentTeam } from "@/types/agent/agent-team"
import {
  __resetAgentTeamDexieBridgeForTesting,
  setAgentTeamBindingCandidateResolver,
  startAgentTeamDexieBridge,
  whenAgentTeamDexieBridgeHydrated,
} from "./dexie-bridge"
import { useAgentTeamStore } from "./store"

function team(id: string, over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id,
    projectId: "ws_1",
    name: id,
    description: "",
    task: "",
    status: "idle",
    config: {},
    leadId: `${id}_lead`,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1_000),
    ...over,
  } as AgentTeam
}

/** The bridge coalesces a burst, so a test has to outlast the debounce. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 600))
}

async function emptyTables() {
  const stored = await loadAgentTeamDefinitions()
  await writeAgentTeamDefinitions({
    teams: [],
    teammates: [],
    tasks: [],
    deleteTeamIds: stored.teams.map((t) => t.id),
    deleteTeammateIds: stored.teammates.map((m) => m.id),
    deleteTaskIds: stored.tasks.map((t) => t.id),
  })
}

describe("agent-team dexie bridge", () => {
  let stop: () => void = () => {}

  beforeEach(async () => {
    __resetAgentTeamDexieBridgeForTesting()
    await emptyTables()
    useAgentTeamStore.setState({ teams: {}, teammates: {}, tasks: {} })
  })

  afterEach(() => {
    stop()
    __resetAgentTeamDexieBridgeForTesting()
  })

  /**
   * The first sync after persist v8 is what moves the old localStorage blob
   * into Dexie: hydration seeds nothing, so everything memory holds is written.
   */
  it("writes what memory already holds down to Dexie", async () => {
    useAgentTeamStore.setState({ teams: { a: team("a") } })
    stop = startAgentTeamDexieBridge()
    await settle()

    expect((await loadAgentTeamDefinitions()).teams.map((t) => t.id)).toEqual(["a"])
  })

  it("seeds memory from Dexie for squads memory does not have", async () => {
    await writeAgentTeamDefinitions({ teams: [team("stored")], teammates: [], tasks: [], now: 1 })
    stop = startAgentTeamDexieBridge()
    await settle()

    expect(Object.keys(useAgentTeamStore.getState().teams)).toContain("stored")
  })

  /** Memory is either what the user is editing or the un-migrated blob. */
  it("lets memory win a conflict with the stored row", async () => {
    await writeAgentTeamDefinitions({
      teams: [team("a", { name: "on disk" })],
      teammates: [],
      tasks: [],
      now: 1,
    })
    useAgentTeamStore.setState({ teams: { a: team("a", { name: "in memory" }) } })
    stop = startAgentTeamDexieBridge()
    await settle()

    expect(useAgentTeamStore.getState().teams.a?.name).toBe("in memory")
    expect((await loadAgentTeamDefinitions()).teams[0]?.name).toBe("in memory")
  })

  it("mirrors a later change through", async () => {
    stop = startAgentTeamDexieBridge()
    await settle()
    useAgentTeamStore.setState({ teams: { later: team("later") } })
    await settle()

    expect((await loadAgentTeamDefinitions()).teams.map((t) => t.id)).toEqual(["later"])
  })

  it("removes a row the store no longer has", async () => {
    useAgentTeamStore.setState({ teams: { gone: team("gone") } })
    stop = startAgentTeamDexieBridge()
    await settle()
    useAgentTeamStore.setState({ teams: {} })
    await settle()

    expect((await loadAgentTeamDefinitions()).teams).toEqual([])
  })

  /**
   * ADR-0169: a definition still carrying the retired runtime selector is
   * upgraded the first time it comes out of Dexie, bindings are inferred only
   * from the single candidate the resolver returns, and the upgraded row goes
   * back down. A second boot changes nothing.
   */
  it("migrates stored definitions onto the durable contract on hydration", async () => {
    await writeAgentTeamDefinitions({
      teams: [
        team("legacy", {
          config: { runtimeVersion: "legacy", workingDir: "/repo", maxTeammates: 3 } as never,
        }),
      ],
      teammates: [],
      tasks: [],
    })
    setAgentTeamBindingCandidateResolver(async () => ({
      environment: { environmentId: "env-1", versionId: "env-1:v1" },
    }))
    stop = startAgentTeamDexieBridge()
    await whenAgentTeamDexieBridgeHydrated()
    const migrated = useAgentTeamStore.getState().teams.legacy!
    expect(migrated.config).not.toHaveProperty("runtimeVersion")
    expect(migrated.config.repositories).toEqual([
      { id: "primary", role: "primary", path: "/repo", writable: true },
    ])
    expect(migrated.config.environmentRef).toEqual({
      environmentId: "env-1",
      versionId: "env-1:v1",
    })
    expect(migrated.config.contractVersion).toBe(2)
    await settle()
    const stored = await loadAgentTeamDefinitions()
    expect(stored.teams[0]?.config).not.toHaveProperty("runtimeVersion")
    expect(stored.teams[0]?.config.environmentRef).toEqual({
      environmentId: "env-1",
      versionId: "env-1:v1",
    })
  })

  it("is idempotent, so a second boot does not start a second mirror", async () => {
    stop = startAgentTeamDexieBridge()
    const second = startAgentTeamDexieBridge()
    await settle()
    second()
    useAgentTeamStore.setState({ teams: { a: team("a") } })
    await settle()

    expect((await loadAgentTeamDefinitions()).teams).toHaveLength(1)
  })
})
