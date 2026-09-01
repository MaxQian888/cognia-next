const runSyncHandler = jest.fn(async () => ({ pulled: 0, applied: 0 }))
jest.mock("./base", () => ({ runSyncHandler: (...args: unknown[]) => runSyncHandler(...args) }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    agentTeams: { name: "agentTeams" },
    agentTeammates: { name: "agentTeammates" },
    agentTeamTasks: { name: "agentTeamTasks" },
  }),
}))

import { syncAgentTeamTasks, syncAgentTeammates, syncAgentTeams } from "./agent-team-definitions"

const transport = {} as never
const cursor = {} as never

describe("squad definition sync handlers", () => {
  beforeEach(() => runSyncHandler.mockClear())

  /**
   * The name is the wire identity: it selects the host-side reader and the
   * Rust registry entry, so a mismatch fails remotely rather than here.
   */
  it.each([
    [syncAgentTeams, "agentTeams"],
    [syncAgentTeammates, "agentTeammates"],
    [syncAgentTeamTasks, "agentTeamTasks"],
  ])("pulls under its protocol table name", async (run, table) => {
    await run(transport, cursor)
    expect(runSyncHandler).toHaveBeenCalledWith(
      expect.objectContaining({ table }),
      transport,
      cursor
    )
  })

  /** The table is resolved lazily, so a locked account is not read at import. */
  it("resolves the Dexie table only when the pull runs", async () => {
    await syncAgentTeams(transport, cursor)
    const spec = runSyncHandler.mock.calls[0]?.[0] as { getTable: () => { name: string } }
    expect(spec.getTable().name).toBe("agentTeams")
  })
})
