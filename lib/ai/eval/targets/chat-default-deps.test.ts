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
  deleteSession: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({ defaultProvider: "anthropic" })),
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ resolved: true })),
}))
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: jest.fn(async () => ({ store: { provider: "test" } })),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: jest.fn(async () => ({ text: "captured reply", messageId: "m1" })),
}))
jest.mock("@/lib/db/agent-traces", () => ({
  queryBySession: jest.fn(async (sid: string) => [{ sessionId: sid, operationName: "chat" }]),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

import { defaultChatTargetDeps } from "./chat"
import { createSession, deleteSession } from "@/lib/db/sessions"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { getSettings } from "@/lib/db/settings"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"

describe("defaultChatTargetDeps", () => {
  beforeEach(() => jest.clearAllMocks())

  it("cleans up an allocated evaluation session when dispatch setup fails", async () => {
    jest.mocked(resolveSendOptions).mockRejectedValueOnce(new Error("Invalid provider"))
    await expect(
      defaultChatTargetDeps().runTurn({ prompt: "private", model: "x" })
    ).rejects.toThrow("Invalid provider")
    expect(deleteSession).toHaveBeenCalledWith("ses-eval")
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
  })

  it("cleans up when cancellation arrives while the session is being allocated", async () => {
    const controller = new AbortController()
    jest.mocked(createSession).mockImplementationOnce(async () => {
      controller.abort()
      return { id: "ses-eval" } as never
    })
    await expect(
      defaultChatTargetDeps().runTurn({ prompt: "private", model: "x", signal: controller.signal })
    ).rejects.toThrow()
    expect(deleteSession).toHaveBeenCalledWith("ses-eval")
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
  })

  it.each(["settings", "send-options"])(
    "does not dispatch after the account changes while awaiting %s",
    async (stage) => {
      let active = true
      const scope = {
        db: { sessions: { get: jest.fn(async () => ({ id: "ses-eval" })) } },
        assertActive: () => {
          if (!active) throw new Error("Evaluation scope changed")
        },
      } as unknown as EvalPersistenceScope
      const pending = stage === "settings" ? getSettings : resolveSendOptions
      jest.mocked(pending).mockImplementationOnce(async () => {
        active = false
        return {} as never
      })

      await expect(
        defaultChatTargetDeps(scope).runTurn({ prompt: "private prompt", model: "x" })
      ).rejects.toThrow("Evaluation scope changed")
      expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
    }
  )

  it("does not create a session when cancelled while imports are pending", async () => {
    const controller = new AbortController()
    const run = defaultChatTargetDeps().runTurn({
      prompt: "private prompt",
      model: "x",
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toThrow()
    expect(createSession).not.toHaveBeenCalled()
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
  })

  it("synthesizes a character and runs a turn when no characterId is given", async () => {
    const deps = defaultChatTargetDeps()
    const result = await deps.runTurn({ prompt: "hi", model: "claude-opus-4-8" })
    expect(result.text).toBe("captured reply")
    expect(result.sessionId).toBe("ses-eval")
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Eval Run", memoryLearn: false })
    )
  })

  it("resolves an existing character by id", async () => {
    const deps = defaultChatTargetDeps()
    const result = await deps.runTurn({ prompt: "hi", model: "x", characterId: "known", cwd: "/w" })
    expect(result.sessionId).toBe("ses-eval")
  })

  it.each([
    ["string", "Twin question", "Twin question"],
    [
      "blocks",
      [
        { type: "text" as const, text: "First" },
        { type: "image" as const, source: { type: "base64" as const, data: "x" } },
        { type: "text" as const, text: "Second" },
      ],
      "First\nSecond",
    ],
  ])("passes %s Twin prompts through the real context seam", async (_label, prompt, expected) => {
    const deps = defaultChatTargetDeps()
    const character = {
      id: "eval-twin",
      name: "Twin",
      avatarColor: "blue",
      systemPrompt: "Base",
      twinId: "twin-1",
      createdAt: 1,
      updatedAt: 1,
    }

    await deps.runTurn({ prompt: prompt as never, model: "x", character })

    expect(resolveSendOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        character,
        twinDeps: expect.any(Object),
        twinUserMessage: expected,
      })
    )
    expect(createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ characterId: "eval-twin", memoryLearn: false })
    )
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
