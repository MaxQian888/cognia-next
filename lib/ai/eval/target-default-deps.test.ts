/**
 * Coverage for the real desktop wiring in `defaultChatTargetDeps`. The heavy
 * modules it lazy-imports are mocked so the glue executes without a sidecar.
 */

jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: jest.fn(async (id: string) =>
    id === "known" ? { id: "known", name: "C", systemPrompt: "", createdAt: 0, updatedAt: 0 } : null
  ),
}))
jest.mock("@/lib/db/sessions", () => ({
  createSession: jest.fn(async (s: Record<string, unknown>) => ({ id: "ses-eval", ...s })),
  getSession: jest.fn(async () => ({ id: "ses-eval" })),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({ defaultProvider: "anthropic" })),
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ resolved: true })),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: jest.fn(async () => ({ text: "captured reply", messageId: "m1" })),
}))
jest.mock("@/lib/db/agent-traces", () => ({
  queryBySession: jest.fn(async (sid: string) => [{ sessionId: sid, operationName: "chat" }]),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

import { defaultChatTargetDeps } from "./target"

describe("defaultChatTargetDeps", () => {
  it("synthesizes a character and runs a turn when no characterId is given", async () => {
    const deps = defaultChatTargetDeps()
    const result = await deps.runTurn({ prompt: "hi", model: "claude-opus-4-8" })
    expect(result.text).toBe("captured reply")
    expect(result.sessionId).toBe("ses-eval")
  })

  it("resolves an existing character by id", async () => {
    const deps = defaultChatTargetDeps()
    const result = await deps.runTurn({ prompt: "hi", model: "x", characterId: "known", cwd: "/w" })
    expect(result.sessionId).toBe("ses-eval")
  })

  it("throws when the requested character is missing", async () => {
    const deps = defaultChatTargetDeps()
    await expect(deps.runTurn({ prompt: "hi", model: "x", characterId: "ghost" })).rejects.toThrow(
      /not found/
    )
  })

  it("fetches spans by session and reports tool capability", async () => {
    const deps = defaultChatTargetDeps()
    expect(await deps.fetchSpans("ses-eval")).toHaveLength(1)
    expect(deps.isToolCapable()).toBe(true)
  })
})
