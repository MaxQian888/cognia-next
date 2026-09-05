const runSyncHandler = jest.fn(async () => ({ pulled: 0, applied: 0 }))
jest.mock("./base", () => ({
  runSyncHandler: (...args: unknown[]) => (runSyncHandler as (...a: unknown[]) => unknown)(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    agentTeams: { name: "agentTeams" },
    agentTeammates: { name: "agentTeammates" },
    agentTeamTasks: { name: "agentTeamTasks" },
  }),
}))

import {
  sanitizeInboundAgentTeamRows,
  syncAgentTeamTasks,
  syncAgentTeammates,
  syncAgentTeams,
} from "./agent-team-definitions"

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

  /**
   * ADR-0169: an older peer can still sync a row that names a runtime. It is
   * stripped at the door, and every other field survives untouched.
   */
  it("strips the retired runtime selector from inbound Squad rows", () => {
    const rows = sanitizeInboundAgentTeamRows([
      { id: "a", config: { runtimeVersion: "legacy", maxTeammates: 3 } } as never,
      { id: "b", config: { maxTeammates: 1 } } as never,
      { id: "c" } as never,
    ])
    expect(rows[0]).toEqual({ id: "a", config: { maxTeammates: 3 } })
    expect(rows[1]).toEqual({ id: "b", config: { maxTeammates: 1 } })
    expect(rows[2]).toEqual({ id: "c" })
  })

  it("installs the sanitizer as the agentTeams applyRows step", async () => {
    await syncAgentTeams(transport, cursor)
    const spec = (runSyncHandler.mock.calls as unknown[][])[0]?.[0] as {
      applyRows?: (rows: unknown[]) => Promise<void>
    }
    expect(typeof spec.applyRows).toBe("function")
  })

  /** The table is resolved lazily, so a locked account is not read at import. */
  it("resolves the Dexie table only when the pull runs", async () => {
    await syncAgentTeams(transport, cursor)
    const spec = (runSyncHandler.mock.calls as unknown[][])[0]?.[0] as {
      getTable: () => { name: string }
    }
    expect(spec.getTable().name).toBe("agentTeams")
  })
})
