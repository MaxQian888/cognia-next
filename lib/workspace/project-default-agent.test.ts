import { projectDefaultAgentId } from "./project-default-agent"
import type { Character } from "@cognia/agent-config-types"

const agent = { id: "char_reviewer", name: "Reviewer" } as Character
const resolveAgent = jest.fn(async (id: string) => (id === agent.id ? agent : undefined))
const project = { id: "ws1", defaultCharacterId: "char_reviewer" }

beforeEach(() => resolveAgent.mockClear())

describe("projectDefaultAgentId", () => {
  it("seeds the workspace's default agent into a person's plain new chat", async () => {
    await expect(projectDefaultAgentId({ project, seed: {}, resolveAgent })).resolves.toBe(
      "char_reviewer"
    )
  })

  it("keeps a caller's own agent, team or squad", async () => {
    for (const seed of [{ characterId: "other" }, { teamId: "t" }, { squadId: "s" }]) {
      await expect(projectDefaultAgentId({ project, seed, resolveAgent })).resolves.toBeUndefined()
    }
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it("leaves conversations no person started alone", async () => {
    await expect(
      projectDefaultAgentId({ project, seed: {}, activate: false, resolveAgent })
    ).resolves.toBeUndefined()
  })

  it("does nothing without a default or a workspace", async () => {
    await expect(
      projectDefaultAgentId({ project: { id: "ws1" }, seed: {}, resolveAgent })
    ).resolves.toBeUndefined()
    await expect(
      projectDefaultAgentId({
        project: { id: "ws1", defaultCharacterId: "  " },
        seed: {},
        resolveAgent,
      })
    ).resolves.toBeUndefined()
    await expect(
      projectDefaultAgentId({ project: null, seed: {}, resolveAgent })
    ).resolves.toBeUndefined()
  })

  it("skips a default that no longer resolves, including a failing lookup", async () => {
    await expect(
      projectDefaultAgentId({
        project: { id: "ws1", defaultCharacterId: "char_gone" },
        seed: {},
        resolveAgent,
      })
    ).resolves.toBeUndefined()
    await expect(
      projectDefaultAgentId({
        project,
        seed: {},
        resolveAgent: async () => {
          throw new Error("db closed")
        },
      })
    ).resolves.toBeUndefined()
  })
})
