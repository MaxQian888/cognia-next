/**
 * Tests for the plugin agent executor.
 *
 * Covers both execution channels:
 *  - text-only (`streamText`) — the web/mobile fallback and the default when
 *    `toolsEnabled` is not requested;
 *  - tool-enabled (`runAndCaptureAssistantReply` via the sidecar) — gated on
 *    `toolsEnabled` + a reachable desktop sidecar.
 */

import { streamText } from "ai"
import { resolveFeatureProvider, createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { isTauri } from "@/lib/tauri"
import { resolveCharacterById } from "@/lib/db/characters"
import { createSession, getSession, deleteSession } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { executeAgent } from "./agent-executor"

jest.mock("ai", () => ({ streamText: jest.fn() }))
jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: jest.fn((input) => input),
  resolveFeatureProvider: jest.fn(),
  createFeatureProviderModel: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({
  createSession: jest.fn(),
  getSession: jest.fn(),
  deleteSession: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/claude/build-options", () => ({ resolveSendOptions: jest.fn() }))
jest.mock("@/lib/claude/run-and-capture", () => ({ runAndCaptureAssistantReply: jest.fn() }))

const mockStreamText = streamText as jest.MockedFunction<typeof streamText>
const mockResolveProvider = resolveFeatureProvider as jest.MockedFunction<
  typeof resolveFeatureProvider
>
const mockCreateModel = createFeatureProviderModel as jest.MockedFunction<
  typeof createFeatureProviderModel
>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockResolveCharacter = resolveCharacterById as jest.MockedFunction<
  typeof resolveCharacterById
>
const mockCreateSession = createSession as jest.MockedFunction<typeof createSession>
const mockGetSession = getSession as jest.MockedFunction<typeof getSession>
const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockResolveSendOptions = resolveSendOptions as jest.MockedFunction<typeof resolveSendOptions>
const mockRunAndCapture = runAndCaptureAssistantReply as jest.MockedFunction<
  typeof runAndCaptureAssistantReply
>

function primeTextChannel(parts: string[] = ["hello"], finishReason = "stop") {
  mockResolveProvider.mockReturnValue({
    kind: "resolved",
    featureId: "plugin-agent-executor",
    routeProfile: "general-text",
    providerId: "openai",
    model: "gpt-4o",
    apiKey: "sk-x",
    baseURL: "https://api.openai.com/v1",
    protocol: "openai",
    isCustomProvider: false,
    executionMode: "direct-model",
    useProxy: false,
    attemptedProviderIds: ["openai"],
    fallbackProviderIds: [],
  } as never)
  mockCreateModel.mockReturnValue({ id: "model" } as never)
  mockStreamText.mockReturnValue({
    textStream: (async function* () {
      for (const p of parts) yield p
    })(),
    finishReason: Promise.resolve(finishReason),
  } as never)
}

describe("executeAgent", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
  })

  describe("text-only channel", () => {
    it("streams text and reports channel='text', toolsAvailable=false", async () => {
      primeTextChannel(["foo", "bar"])
      const result = await executeAgent("hi")
      expect(result.text).toBe("foobar")
      expect(result.channel).toBe("text")
      expect(result.toolsAvailable).toBe(false)
      expect(result.finishReason).toBe("stop")
      expect(mockRunAndCapture).not.toHaveBeenCalled()
    })

    it("forwards systemPrompt/temperature/abortSignal and tolerates a non-string finishReason", async () => {
      primeTextChannel(["x"], "stop")
      mockStreamText.mockReturnValue({
        textStream: (async function* () {
          yield "x"
        })(),
        finishReason: Promise.resolve(undefined),
      } as never)
      const controller = new AbortController()
      const result = await executeAgent("hi", {
        systemPrompt: "be brief",
        temperature: 0.2,
        abortSignal: controller.signal,
      })
      expect(result.finishReason).toBeUndefined()
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "be brief",
          temperature: 0.2,
          abortSignal: controller.signal,
        })
      )
    })

    it("throws when no provider resolves", async () => {
      mockResolveProvider.mockReturnValue({
        kind: "blocked",
        reason: "no key",
        nextAction: "add_api_key",
      } as never)
      await expect(executeAgent("hi")).rejects.toThrow(/executeAgent: no key/)
    })

    it("falls back to text-only when toolsEnabled but sidecar is unavailable", async () => {
      primeTextChannel(["web"])
      mockIsTauri.mockReturnValue(false)
      const result = await executeAgent("hi", { toolsEnabled: true })
      expect(result.channel).toBe("text")
      expect(result.toolsAvailable).toBe(false)
      expect(result.text).toBe("web")
      expect(mockRunAndCapture).not.toHaveBeenCalled()
    })
  })

  describe("tool-enabled channel (sidecar)", () => {
    beforeEach(() => {
      mockIsTauri.mockReturnValue(true)
      mockCreateSession.mockResolvedValue({ id: "s1" } as never)
      mockGetSession.mockResolvedValue({ id: "s1" } as never)
      mockDeleteSession.mockResolvedValue(undefined as never)
      mockGetSettings.mockResolvedValue({} as never)
      mockResolveSendOptions.mockResolvedValue({ model: "claude" } as never)
      mockRunAndCapture.mockResolvedValue({
        text: "tool-enabled reply",
        messageId: "m1",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })
    })

    it("routes through the sidecar and reports channel='sidecar', toolsAvailable=true", async () => {
      const result = await executeAgent("do work", { toolsEnabled: true, systemPrompt: "be terse" })
      expect(result.channel).toBe("sidecar")
      expect(result.toolsAvailable).toBe(true)
      expect(result.text).toBe("tool-enabled reply")
      expect(mockResolveSendOptions).toHaveBeenCalled()
      expect(mockRunAndCapture).toHaveBeenCalledWith(
        "s1",
        "do work",
        { model: "claude" },
        expect.any(Object)
      )
      expect(mockStreamText).not.toHaveBeenCalled()
    })

    it("synthesises a character when no characterId is given", async () => {
      await executeAgent("x", {
        toolsEnabled: true,
        model: "claude-opus-4-8",
        allowedTools: ["Bash"],
      })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.id).toBe("__plugin-agent__")
      expect(ctx.character?.model).toBe("claude-opus-4-8")
      expect(ctx.character?.allowedTools).toEqual(["Bash"])
    })

    it("synthesises a minimal character (systemPrompt + cwd, no model/tools)", async () => {
      await executeAgent("x", { toolsEnabled: true, systemPrompt: "scoped", cwd: "/repo" })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.systemPrompt).toBe("scoped")
      expect(ctx.character?.workingDir).toBe("/repo")
      expect(ctx.character?.model).toBeUndefined()
      expect(ctx.character?.allowedTools).toBeUndefined()
    })

    it("falls back to a default system prompt when none is supplied", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.systemPrompt).toMatch(/helpful agent/i)
    })

    it("resolves an existing character by id", async () => {
      mockResolveCharacter.mockResolvedValue({ id: "char-1", name: "Persona" } as never)
      await executeAgent("x", { toolsEnabled: true, characterId: "char-1" })
      expect(mockResolveCharacter).toHaveBeenCalledWith("char-1")
      const ctx = mockResolveSendOptions.mock.calls[0][0]
      expect(ctx.character?.id).toBe("char-1")
    })

    it("throws when characterId cannot be resolved", async () => {
      mockResolveCharacter.mockResolvedValue(null as never)
      await expect(
        executeAgent("x", { toolsEnabled: true, characterId: "missing" })
      ).rejects.toThrow(/character "missing" not found/)
    })

    it("tears down the ephemeral session even when the run fails", async () => {
      mockRunAndCapture.mockRejectedValue(new Error("boom"))
      await expect(executeAgent("x", { toolsEnabled: true })).rejects.toThrow("boom")
      expect(mockDeleteSession).toHaveBeenCalledWith("s1")
    })

    it("forwards an explicit timeout to the runner", async () => {
      await executeAgent("x", { toolsEnabled: true, timeoutMs: 1234 })
      const capArg = mockRunAndCapture.mock.calls[0][3]
      expect(capArg).toMatchObject({ timeoutMs: 1234 })
    })

    it("appends system + structured instruction onto sendOptions.appendSystemPrompt", async () => {
      mockResolveSendOptions.mockResolvedValue({
        model: "claude",
        appendSystemPrompt: "BASE",
      } as never)
      await executeAgent("x", {
        toolsEnabled: true,
        appendSystem: "EXTRA",
        outputFormat: { type: "json_schema", schema: { ok: "boolean" } },
      })
      const sendOpts = mockRunAndCapture.mock.calls[0][2] as { appendSystemPrompt: string }
      expect(sendOpts.appendSystemPrompt).toContain("BASE")
      expect(sendOpts.appendSystemPrompt).toContain("EXTRA")
      expect(sendOpts.appendSystemPrompt).toMatch(/JSON/i)
    })

    it("forwards onEvent and a canUseTool-derived permission responder to the runner", async () => {
      const onEvent = jest.fn()
      const canUseTool = jest.fn(async () => ({ behavior: "allow" as const }))
      await executeAgent("x", { toolsEnabled: true, onEvent, canUseTool })
      const capArg = mockRunAndCapture.mock.calls[0][3] as {
        onEvent?: (e: unknown) => void
        onPermissionRequest?: (r: unknown) => Promise<unknown>
      }
      // onEvent is now wrapped (to also drive onPostToolUse), so it forwards
      // rather than being the same reference.
      expect(typeof capArg.onEvent).toBe("function")
      capArg.onEvent?.({ type: "text-delta", delta: "hi" })
      expect(onEvent).toHaveBeenCalledWith({ type: "text-delta", delta: "hi" })
      expect(typeof capArg.onPermissionRequest).toBe("function")
      // The responder adapts the gate's allow/deny → approveTool decision shape.
      const decision = await capArg.onPermissionRequest!({ toolName: "t", input: { a: 1 } })
      expect(canUseTool).toHaveBeenCalledWith("t", { a: 1 }, expect.any(Object))
      expect(decision).toEqual({ decision: "allow", updatedInput: undefined })
    })

    it("does not attach a permission responder when no canUseTool is given", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const capArg = mockRunAndCapture.mock.calls[0][3] as { onPermissionRequest?: unknown }
      expect(capArg.onPermissionRequest).toBeUndefined()
    })

    it("wires onPostToolUse as a tool-result review responder + enables review on sendOptions", async () => {
      const onPostToolUse = jest.fn(async () => ({ updatedToolOutput: "CLEAN" }))
      await executeAgent("x", { toolsEnabled: true, onPostToolUse })
      const sendOpts = mockRunAndCapture.mock.calls[0][2] as { toolResultReviewEnabled?: boolean }
      expect(sendOpts.toolResultReviewEnabled).toBe(true)
      const capArg = mockRunAndCapture.mock.calls[0][3] as {
        onToolResultReview?: (r: unknown) => Promise<{ updatedToolOutput?: unknown }>
      }
      expect(typeof capArg.onToolResultReview).toBe("function")
      const decision = await capArg.onToolResultReview!({
        toolName: "web_fetch",
        input: { url: "x" },
        result: "RAW",
        isError: false,
      })
      expect(onPostToolUse).toHaveBeenCalledWith(
        { toolName: "web_fetch", input: { url: "x" }, result: "RAW", isError: false },
        expect.any(Object)
      )
      expect(decision).toEqual({ updatedToolOutput: "CLEAN" })
    })

    it("does not enable review or attach a responder without onPostToolUse", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const sendOpts = mockRunAndCapture.mock.calls[0][2] as { toolResultReviewEnabled?: boolean }
      const capArg = mockRunAndCapture.mock.calls[0][3] as { onToolResultReview?: unknown }
      expect(sendOpts.toolResultReviewEnabled).toBeUndefined()
      expect(capArg.onToolResultReview).toBeUndefined()
    })

    it("does not attach onEvent when no onEvent is given", async () => {
      await executeAgent("x", { toolsEnabled: true })
      const capArg = mockRunAndCapture.mock.calls[0][3] as { onEvent?: unknown }
      expect(capArg.onEvent).toBeUndefined()
    })

    it("parses structured output from the sidecar reply onto result.object", async () => {
      mockRunAndCapture.mockResolvedValue({
        text: '{"ok": true}',
        messageId: "m1",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })
      const result = await executeAgent("x", {
        toolsEnabled: true,
        outputFormat: { type: "json_schema", schema: { ok: "boolean" } },
      })
      expect(result.object).toEqual({ ok: true })
      expect(result.parseError).toBeUndefined()
    })
  })

  describe("structured output (text channel)", () => {
    it("parses a JSON reply onto result.object", async () => {
      primeTextChannel(['{"a":', " 1}"])
      const result = await executeAgent("hi", {
        outputFormat: { type: "json_schema", schema: { a: "number" } },
      })
      expect(result.object).toEqual({ a: 1 })
      expect(result.parseError).toBeUndefined()
      // The JSON instruction was appended to the system prompt.
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ system: expect.stringMatching(/JSON/i) })
      )
    })

    it("surfaces parseError (never throws) when the reply is not JSON", async () => {
      primeTextChannel(["totally not json"])
      const result = await executeAgent("hi", {
        outputFormat: { type: "json_schema", schema: { a: "number" } },
      })
      expect(result.object).toBeUndefined()
      expect(typeof result.parseError).toBe("string")
    })

    it("emits text-delta events through onEvent on the text channel", async () => {
      primeTextChannel(["foo", "bar"])
      const events: Array<{ type: string; delta?: string }> = []
      await executeAgent("hi", { onEvent: (e) => events.push(e) })
      expect(events).toEqual([
        { type: "text-delta", delta: "foo" },
        { type: "text-delta", delta: "bar" },
      ])
    })

    it("composes systemPrompt + appendSystem", async () => {
      primeTextChannel(["x"])
      await executeAgent("hi", { systemPrompt: "BASE", appendSystem: "EXTRA" })
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ system: "BASE\n\nEXTRA" })
      )
    })
  })
})
