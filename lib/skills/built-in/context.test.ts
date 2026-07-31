const mockSessionGet = jest.fn()
const mockProjectGet = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    sessions: { get: (...a: unknown[]) => mockSessionGet(...a) },
    projects: { get: (...a: unknown[]) => mockProjectGet(...a) },
  })),
}))

const mockReadForResolution = jest.fn()
jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: (...a: unknown[]) => mockReadForResolution(...a),
}))

import { resolveBuiltInSkillContext } from "./context"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("resolveBuiltInSkillContext", () => {
  it("hydrates imBinding + imOverrideRow for a platform-bound session", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: {
        platform: "lark",
        adapterId: "a1",
        conversationKey: "lark:a1:oc_1",
      },
    })
    mockReadForResolution.mockResolvedValue({ requireHitlForWrites: true })
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.sessionId).toBe("s1")
    expect(ctx.imBinding).toEqual({
      adapterId: "a1",
      platform: "lark",
      conversationKey: "lark:a1:oc_1",
    })
    expect(ctx.imOverrideRow).toEqual({ requireHitlForWrites: true })
    expect(mockReadForResolution).toHaveBeenCalledWith("lark:a1:oc_1")
  })

  it("returns a bare context for desktop (non-bound) sessions", async () => {
    mockSessionGet.mockResolvedValue({ id: "s1" })
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx).toEqual({ sessionId: "s1" })
    expect(mockReadForResolution).not.toHaveBeenCalled()
  })

  it("uses the session working directory as the desktop workspace root", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      workingDir: " /workspace/session ",
      projectId: "project-1",
    })

    await expect(resolveBuiltInSkillContext("s1")).resolves.toMatchObject({
      sessionId: "s1",
      workspaceRoot: "/workspace/session",
    })
    expect(mockProjectGet).not.toHaveBeenCalled()
  })

  it("falls back to the linked project's primary root", async () => {
    mockSessionGet.mockResolvedValue({ id: "s1", projectId: "project-1" })
    mockProjectGet.mockResolvedValue({
      id: "project-1",
      roots: [
        { id: "secondary", path: "/workspace/secondary" },
        { id: "primary", path: "/workspace/primary", isPrimary: true },
      ],
    })

    await expect(resolveBuiltInSkillContext("s1")).resolves.toMatchObject({
      sessionId: "s1",
      workspaceRoot: "/workspace/primary",
    })
    expect(mockProjectGet).toHaveBeenCalledWith("project-1")
  })

  it("keeps hydrating connector context when the linked project cannot be read", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      projectId: "project-1",
      platformBinding: {
        platform: "lark",
        adapterId: "a1",
        conversationKey: "lark:a1:oc_1",
      },
    })
    mockProjectGet.mockRejectedValue(new Error("project table unavailable"))
    mockReadForResolution.mockResolvedValue(null)

    await expect(resolveBuiltInSkillContext("s1")).resolves.toMatchObject({
      sessionId: "s1",
      imBinding: { adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
  })

  it("keeps the binding when the override read fails (best-effort)", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
    mockReadForResolution.mockRejectedValue(new Error("dexie down"))
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.imBinding?.adapterId).toBe("a1")
    expect(ctx.imOverrideRow).toBeUndefined()
  })

  it("falls back to the bare context when the session lookup throws", async () => {
    mockSessionGet.mockRejectedValue(new Error("no db"))
    expect(await resolveBuiltInSkillContext("s1")).toEqual({ sessionId: "s1" })
  })

  it("treats a missing override row (null) as undefined", async () => {
    mockSessionGet.mockResolvedValue({
      id: "s1",
      platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    })
    mockReadForResolution.mockResolvedValue(null)
    const ctx = await resolveBuiltInSkillContext("s1")
    expect(ctx.imOverrideRow).toBeUndefined()
  })
})
