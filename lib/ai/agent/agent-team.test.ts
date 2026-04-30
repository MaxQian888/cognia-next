import { agentTeamManager } from "./agent-team"

describe("agentTeamManager (stub)", () => {
  it("list() returns an empty array", () => {
    expect(agentTeamManager.list()).toEqual([])
  })

  it("get() returns undefined for any id", () => {
    expect(agentTeamManager.get("anything")).toBeUndefined()
  })

  it("create() echoes the input as an AgentTeam", () => {
    const cfg = { id: "t1", name: "Team", members: [] } as unknown as Parameters<
      typeof agentTeamManager.create
    >[0]
    expect(agentTeamManager.create(cfg)).toBe(cfg)
  })

  it("update() resolves to undefined", () => {
    expect(agentTeamManager.update("t1", { name: "x" } as never)).toBeUndefined()
  })

  it("delete() resolves to undefined", () => {
    expect(agentTeamManager.delete("t1")).toBeUndefined()
  })

  it("start() resolves with no value", async () => {
    await expect(agentTeamManager.start("t1")).resolves.toBeUndefined()
  })

  it("pause() resolves with no value", async () => {
    await expect(agentTeamManager.pause("t1")).resolves.toBeUndefined()
  })

  it("shutdown() resolves with no value", async () => {
    await expect(agentTeamManager.shutdown("t1")).resolves.toBeUndefined()
  })
})
