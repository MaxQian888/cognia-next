jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  resolveChatCapableAdapter: jest.fn(),
  withScopeCapture: jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./update-chat"
import { resolveChatCapableAdapter } from "./_helpers"

const mResolve = resolveChatCapableAdapter as jest.Mock
const mUpdate = jest.fn().mockResolvedValue(undefined)

function skill() {
  const s = getSharedBuiltInSkillRegistry()
    .list()
    .find((x) => x.id === "im.update_chat")
  if (!s) throw new Error("im.update_chat not registered")
  return s
}

beforeEach(() => {
  jest.clearAllMocks()
  mResolve.mockResolvedValue({
    adapterId: "a1",
    platform: "lark",
    adapter: { updateChat: mUpdate },
  })
})

describe("im.update_chat", () => {
  it("schema refuses a patch with neither name nor description", () => {
    const parsed = skill().inputSchema.safeParse({ chatId: "oc_1" })
    expect(parsed.success).toBe(false)
  })

  it("updates name/description on an explicit chat", async () => {
    const out = await skill().execute(
      { chatId: "oc_1", name: "New", description: "D" },
      { sessionId: "s" }
    )
    expect(mUpdate).toHaveBeenCalledWith({ chatId: "oc_1", name: "New", description: "D" })
    expect(out).toEqual({ chatId: "oc_1", updated: true })
  })

  it("defaults to the bound conversation's chat id", async () => {
    await skill().execute(
      { name: "New" },
      {
        sessionId: "s",
        imBinding: { adapterId: "a1", platform: "lark", conversationKey: "lark:a1:oc_bound" },
      }
    )
    expect(mUpdate).toHaveBeenCalledWith({
      chatId: "oc_bound",
      name: "New",
      description: undefined,
    })
  })

  it("throws when no chatId is derivable", async () => {
    await expect(skill().execute({ name: "New" }, { sessionId: "s" })).rejects.toThrow(
      /chatId is required/
    )
  })

  it("supports description-only updates", async () => {
    await skill().execute({ chatId: "oc_1", description: "Only desc" }, { sessionId: "s" })
    expect(mUpdate).toHaveBeenCalledWith({
      chatId: "oc_1",
      name: undefined,
      description: "Only desc",
    })
  })

  it("hitlSurface lists only the provided fields", () => {
    const surface = skill().hitlSurface!({ name: "N" } as never)
    const texts = JSON.stringify(surface.components)
    expect(texts).toContain("New name")
    expect(texts).not.toContain("New description")
  })
})
