import { WasmBridgeError } from "../errors"
import { MAX_PAYLOAD_BYTES } from "../protocol"

// `mock`-prefixed so the jest.mock factories can reference them without TDZ.
const mockChat = jest.fn()
const mockCreateAIProviderAPI = jest.fn(() => ({ chat: mockChat }))
const mockHasApiOrGuardPermission = jest.fn(() => true)

jest.mock("@/lib/plugin/api/ai-provider-api", () => ({
  createAIProviderAPI: (...args: unknown[]) => mockCreateAIProviderAPI(...(args as [])),
}))
jest.mock("@/lib/plugin/api/api-permission-gate", () => ({
  hasApiOrGuardPermission: (...args: unknown[]) => mockHasApiOrGuardPermission(...(args as [])),
}))

import { aiGenerateText } from "./ai-generate-text"

function chunks(...items: Array<Record<string, unknown>>) {
  return async function* () {
    for (const item of items) yield item
  }
}

const signal = () => new AbortController().signal
const payload = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "hi" }],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockHasApiOrGuardPermission.mockReturnValue(true)
  mockCreateAIProviderAPI.mockReturnValue({ chat: mockChat })
})

describe("streaming drain", () => {
  it("concatenates every chunk into one string", async () => {
    // The WIT contract is one-shot; the provider API is a generator. This
    // adapter is the whole reason the handler exists.
    mockChat.mockImplementation(
      chunks({ content: "Hello" }, { content: ", " }, { content: "world" })
    )
    const result = await aiGenerateText("p", payload(), signal())
    expect(result.text).toBe("Hello, world")
  })

  it("captures the trailing usage chunk into the envelope", async () => {
    mockChat.mockImplementation(
      chunks(
        { content: "out" },
        {
          content: "",
          finishReason: "stop",
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        }
      )
    )
    const result = await aiGenerateText("p", payload(), signal())
    expect(result.text).toBe("out")
    expect(result.finishReason).toBe("stop")
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 })
  })

  it("returns an empty string when the provider yields nothing", async () => {
    mockChat.mockImplementation(chunks())
    await expect(aiGenerateText("p", payload(), signal())).resolves.toMatchObject({ text: "" })
  })
})

describe("cancellation", () => {
  it("forwards the abort signal into the provider options", async () => {
    // Without this the abort only stops our loop; the provider keeps streaming
    // and the user keeps paying for tokens nobody will read.
    mockChat.mockImplementation(chunks({ content: "x" }))
    const s = signal()
    await aiGenerateText("p", payload(), s)
    expect(mockChat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: s }))
  })

  it("stops accumulating mid-stream once aborted", async () => {
    const controller = new AbortController()
    mockChat.mockImplementation(async function* () {
      yield { content: "first" }
      controller.abort()
      yield { content: "second" }
    })
    const result = await aiGenerateText("p", payload(), controller.signal)
    expect(result.text).toBe("first")
  })
})

describe("permission gate", () => {
  it("denies without ai:chat and never constructs the provider API", async () => {
    mockHasApiOrGuardPermission.mockReturnValue(false)
    await expect(aiGenerateText("p", payload(), signal())).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    })
    expect(mockCreateAIProviderAPI).not.toHaveBeenCalled()
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("checks the ai:chat permission specifically", async () => {
    mockChat.mockImplementation(chunks({ content: "x" }))
    await aiGenerateText("acme.plugin", payload(), signal())
    expect(mockHasApiOrGuardPermission).toHaveBeenCalledWith("acme.plugin", "ai:chat")
  })
})

describe("validation", () => {
  it.each([
    ["missing messages", {}],
    ["empty messages", { messages: [] }],
    ["messages not an array", { messages: "hi" }],
  ])("rejects %s as INVALID_REQUEST", async (_label, body) => {
    await expect(
      aiGenerateText("p", body as Record<string, unknown>, signal())
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })

  it("rejects a bad role", async () => {
    await expect(
      aiGenerateText("p", { messages: [{ role: "root", content: "x" }] }, signal())
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })

  it("rejects non-string content", async () => {
    await expect(
      aiGenerateText("p", { messages: [{ role: "user", content: 42 }] }, signal())
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })

  it("rejects an oversized payload before touching the provider", async () => {
    const big = payload({ messages: [{ role: "user", content: "x".repeat(MAX_PAYLOAD_BYTES) }] })
    await expect(aiGenerateText("p", big, signal())).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    })
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("validates shape before checking permissions", async () => {
    // Cheap checks first: a malformed request should not consult the guard.
    mockHasApiOrGuardPermission.mockReturnValue(false)
    await expect(aiGenerateText("p", {}, signal())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
  })
})

describe("option passthrough", () => {
  it("forwards the recognised generation options", async () => {
    mockChat.mockImplementation(chunks({ content: "x" }))
    await aiGenerateText(
      "p",
      payload({ model: "m", temperature: 0.4, maxTokens: 256, topP: 0.9, stop: ["END"] }),
      signal()
    )
    expect(mockChat).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      expect.objectContaining({
        model: "m",
        temperature: 0.4,
        maxTokens: 256,
        topP: 0.9,
        stop: ["END"],
      })
    )
  })

  it("ignores options of the wrong type rather than passing them through", async () => {
    mockChat.mockImplementation(chunks({ content: "x" }))
    await aiGenerateText("p", payload({ model: 7, temperature: "hot", stop: [1, 2] }), signal())
    const options = mockChat.mock.calls[0][1] as Record<string, unknown>
    expect(options.model).toBeUndefined()
    expect(options.temperature).toBeUndefined()
    expect(options.stop).toBeUndefined()
  })
})

describe("provider failures", () => {
  it("lets a PII rejection propagate for the caller to classify", async () => {
    // The PII gate runs inside chat(), so a WASM guest cannot bypass it by
    // coming through the bridge instead of the TS plugin API.
    const piiError = new Error("would leak PII")
    piiError.name = "PluginPiiError"
    mockChat.mockImplementation(() => {
      throw piiError
    })
    await expect(aiGenerateText("p", payload(), signal())).rejects.toThrow("would leak PII")
  })

  it("lets a provider error propagate unwrapped", async () => {
    mockChat.mockImplementation(async function* () {
      yield { content: "partial" }
      throw new Error("upstream 502")
    })
    await expect(aiGenerateText("p", payload(), signal())).rejects.toThrow("upstream 502")
  })

  it("throws a typed error for an unserializable payload", async () => {
    const cyclic: Record<string, unknown> = payload()
    cyclic.self = cyclic
    await expect(aiGenerateText("p", cyclic, signal())).rejects.toBeInstanceOf(WasmBridgeError)
  })
})
