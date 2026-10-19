import { primeCliPromptOverrides } from "./prompt-overrides"

describe("primeCliPromptOverrides", () => {
  it("stays off the database when the store holds no overrides", async () => {
    const ensureDb = jest.fn(async () => undefined)
    const loadSnapshot = jest.fn(async () => undefined)
    await expect(
      primeCliPromptOverrides("/repo", { mayHoldRows: () => false, ensureDb, loadSnapshot })
    ).resolves.toEqual({})
    expect(ensureDb).not.toHaveBeenCalled()
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it("opens the store, loads the snapshot, and names the workspace mounting the cwd", async () => {
    const order: string[] = []
    const result = await primeCliPromptOverrides("/repo", {
      mayHoldRows: () => true,
      ensureDb: async () => void order.push("open"),
      loadSnapshot: async () => void order.push("load"),
      findWorkspaceId: async (cwd) => (order.push(`find:${cwd}`), "ws-1"),
    })
    expect(order).toEqual(["open", "load", "find:/repo"])
    expect(result).toEqual({ workspaceId: "ws-1" })
  })

  it("omits the workspace when none mounts the cwd", async () => {
    await expect(
      primeCliPromptOverrides("/tmp", {
        mayHoldRows: () => true,
        ensureDb: async () => undefined,
        loadSnapshot: async () => undefined,
        findWorkspaceId: async () => null,
      })
    ).resolves.toEqual({})
  })

  it("leaves every slot on its shipped text when the store cannot open", async () => {
    const loadSnapshot = jest.fn(async () => undefined)
    await expect(
      primeCliPromptOverrides("/repo", {
        mayHoldRows: () => true,
        ensureDb: async () => {
          throw new Error("locked")
        },
        loadSnapshot,
      })
    ).resolves.toEqual({})
    expect(loadSnapshot).not.toHaveBeenCalled()
  })
})
