/**
 * Tests for the renderer-side `vscode.lm` handler. Covers:
 *   - model list filtering by selector fields
 *   - default-model marking via the injected resolver
 *   - registration / unregistration for chat-model, MCP, and tool providers
 *   - bulk cleanup on extension teardown
 *   - sendChatRequest invocations are exercised through a mocked
 *     `ai` package — we don't want to hit Anthropic in unit tests.
 */

jest.mock("ai", () => {
  const generateText = jest.fn(async () => ({
    text: "mocked output",
    usage: { inputTokens: 7, outputTokens: 5 },
  }))
  return { generateText, __generateTextMock: generateText }
})

jest.mock("@cognia/provider-core/core/client", () => ({
  getProviderModel: jest.fn(() => ({ modelId: "fake-model" })),
}))

import {
  __listLmRegistrationsForTesting,
  __resetLmHandlerForTesting,
  configureLmHandler,
  handleRegisterChatModelProvider,
  handleRegisterMcpServerDefinitionProvider,
  handleRegisterTool,
  handleSelectChatModels,
  handleSendChatRequest,
  handleUnregisterChatModelProvider,
  handleUnregisterMcpServerDefinitionProvider,
  handleUnregisterTool,
  unregisterAllLmFor,
} from "./lm-handler"
import { getProviderModel } from "@cognia/provider-core/core/client"

// The ai package is hoisted-mocked above; this typed re-import gives access
// to the spy without TS errors when calling jest.MockedFunction.
import * as aiPkg from "ai"
const generateTextMock = (aiPkg as unknown as { generateText: jest.Mock }).generateText

describe("lm-handler — selectChatModels", () => {
  beforeEach(() => {
    __resetLmHandlerForTesting()
    generateTextMock.mockClear()
  })

  it("returns all three cognia models with the default marked", async () => {
    configureLmHandler({ resolveDefaultModel: async () => "claude-opus-4-7" })
    const models = await handleSelectChatModels({ extensionId: "ext" })
    expect(models).toHaveLength(3)
    const opus = models.find((m) => m.id === "claude-opus-4-7")
    expect(opus?.isDefault).toBe(true)
    const others = models.filter((m) => m.id !== "claude-opus-4-7")
    others.forEach((m) => expect(m.isDefault).toBe(false))
  })

  it("falls back to sonnet when the resolver returns an unknown model", async () => {
    configureLmHandler({ resolveDefaultModel: async () => "claude-sonnet-7" })
    const models = await handleSelectChatModels({ extensionId: "ext" })
    const sonnet = models.find((m) => m.id === "claude-sonnet-4-6")
    expect(sonnet?.isDefault).toBe(true)
  })

  it("falls back to sonnet when the resolver throws", async () => {
    configureLmHandler({
      resolveDefaultModel: async () => {
        throw new Error("settings broken")
      },
    })
    const models = await handleSelectChatModels({ extensionId: "ext" })
    expect(models.find((m) => m.id === "claude-sonnet-4-6")?.isDefault).toBe(true)
  })

  it("filters by vendor, family, version, and id", async () => {
    const onlyOpus = await handleSelectChatModels({
      extensionId: "ext",
      selector: { id: "claude-opus-4-7" },
    })
    expect(onlyOpus).toHaveLength(1)

    const noneForOpenAi = await handleSelectChatModels({
      extensionId: "ext",
      selector: { vendor: "openai" },
    })
    expect(noneForOpenAi).toEqual([])

    const allAnthropic = await handleSelectChatModels({
      extensionId: "ext",
      selector: { family: "anthropic" },
    })
    expect(allAnthropic).toHaveLength(3)

    const byVersion = await handleSelectChatModels({
      extensionId: "ext",
      selector: { version: "4.5" },
    })
    expect(byVersion).toHaveLength(1)
    expect(byVersion[0]!.id).toBe("claude-haiku-4-5-20251001")
  })
})

describe("lm-handler — sendChatRequest", () => {
  beforeEach(() => {
    __resetLmHandlerForTesting()
    generateTextMock.mockClear()
  })

  it("calls generateText with the default model when none is provided", async () => {
    configureLmHandler({ resolveDefaultModel: async () => "claude-sonnet-4-6" })
    const out = await handleSendChatRequest({
      extensionId: "ext",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out).toEqual({
      modelId: "claude-sonnet-4-6",
      text: "mocked output",
      usage: { inputTokens: 7, outputTokens: 5 },
    })
    expect(getProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-4-6" })
    )
  })

  it("honours an explicit modelId", async () => {
    const out = await handleSendChatRequest({
      extensionId: "ext",
      modelId: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.modelId).toBe("claude-opus-4-7")
  })

  it("rejects unknown model ids", async () => {
    await expect(
      handleSendChatRequest({
        extensionId: "ext",
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toThrow(/unknown model/)
  })

  it("rejects empty message arrays", async () => {
    await expect(handleSendChatRequest({ extensionId: "ext", messages: [] })).rejects.toThrow(
      /at least one message/
    )
  })

  it("hoists a leading system message out of messages into instructions", async () => {
    // AI SDK 7 rejects `{ role: "system" }` inside `messages`; extensions send a
    // flat history that commonly leads with one.
    await handleSendChatRequest({
      extensionId: "ext",
      modelId: "claude-opus-4-7",
      messages: [
        { role: "system", content: "You are a code reviewer." },
        { role: "user", content: "review this" },
      ],
    })

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: [{ role: "system", content: "You are a code reviewer." }],
        messages: [{ role: "user", content: "review this" }],
      })
    )
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty("allowSystemInMessages")
  })

  it("keeps a mid-history system message in place and opts it back in", async () => {
    await handleSendChatRequest({
      extensionId: "ext",
      modelId: "claude-opus-4-7",
      messages: [
        { role: "user", content: "review this" },
        { role: "system", content: "Be brief now." },
      ],
    })

    const call = generateTextMock.mock.calls[0][0]
    expect(call).not.toHaveProperty("instructions")
    expect(call.allowSystemInMessages).toBe(true)
    expect(call.messages).toEqual([
      { role: "user", content: "review this" },
      { role: "system", content: "Be brief now." },
    ])
  })

  it("forwards the explicit maxOutputTokens option to generateText", async () => {
    await handleSendChatRequest({
      extensionId: "ext",
      modelId: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      options: { maxOutputTokens: 256 },
    })
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 256 }))
  })

  it("falls back to the model's BASE_MODELS output budget when no cap is given", async () => {
    await handleSendChatRequest({
      extensionId: "ext",
      modelId: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
    })
    // claude-opus-4-7 → maxOutputTokens 32_000 in BASE_MODELS.
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 32_000 })
    )
  })
})

describe("lm-handler — provider registration", () => {
  beforeEach(() => {
    __resetLmHandlerForTesting()
  })

  it("registers and unregisters a chat-model provider", () => {
    handleRegisterChatModelProvider({
      extensionId: "ext.continue",
      id: "continue-claude",
      token: "tok-a",
    })
    expect(__listLmRegistrationsForTesting()).toHaveLength(1)
    handleUnregisterChatModelProvider({
      extensionId: "ext.continue",
      id: "continue-claude",
    })
    expect(__listLmRegistrationsForTesting()).toHaveLength(0)
  })

  it("registers and unregisters an MCP server definition provider", () => {
    handleRegisterMcpServerDefinitionProvider({
      extensionId: "ext.cline",
      id: "cline-mcp",
      token: "tok-b",
      meta: { label: "Cline MCP" },
    })
    expect(__listLmRegistrationsForTesting()).toHaveLength(1)
    handleUnregisterMcpServerDefinitionProvider({
      extensionId: "ext.cline",
      id: "cline-mcp",
    })
    expect(__listLmRegistrationsForTesting()).toHaveLength(0)
  })

  it("registers and unregisters a tool", () => {
    handleRegisterTool({
      extensionId: "ext.tool",
      name: "search_repo",
      token: "tok-c",
      description: "Search code",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    })
    expect(__listLmRegistrationsForTesting()).toHaveLength(1)
    handleUnregisterTool({ extensionId: "ext.tool", name: "search_repo" })
    expect(__listLmRegistrationsForTesting()).toHaveLength(0)
  })

  it("unregister is a no-op when the id is missing", () => {
    handleRegisterTool({
      extensionId: "ext.tool",
      name: "x",
      token: "tok",
    })
    handleUnregisterTool({ extensionId: "ext.tool" })
    expect(__listLmRegistrationsForTesting()).toHaveLength(1)
  })

  it("unregisterAllLmFor drops every registration for an extension", () => {
    handleRegisterChatModelProvider({
      extensionId: "ext",
      id: "a",
      token: "t1",
    })
    handleRegisterTool({
      extensionId: "ext",
      name: "b",
      token: "t2",
    })
    handleRegisterMcpServerDefinitionProvider({
      extensionId: "other",
      id: "c",
      token: "t3",
    })
    unregisterAllLmFor("ext")
    const rest = __listLmRegistrationsForTesting()
    expect(rest).toHaveLength(1)
    expect(rest[0]!.extensionId).toBe("other")
  })
})
