jest.mock("@cognia/provider-core/core/client", () => ({
  __esModule: true,
  getProviderModel: jest.fn(),
}))
jest.mock("ai", () => ({
  __esModule: true,
  generateText: jest.fn(),
}))

import { generateImageCaption } from "./caption"
import { getProviderModel as getProviderModelMock } from "@cognia/provider-core/core/client"
import { generateText as generateTextMock } from "ai"

const getProviderModel = getProviderModelMock as unknown as jest.Mock
const generateText = generateTextMock as unknown as jest.Mock

describe("generateImageCaption", () => {
  beforeEach(() => {
    getProviderModel.mockReset()
    generateText.mockReset()
  })

  it("calls getProviderModel with the supplied (provider, model, apiKey, baseURL)", async () => {
    getProviderModel.mockReturnValue({ stub: true })
    generateText.mockResolvedValue({ text: "a cat" })

    await generateImageCaption("data:image/png;base64,xyz", {
      apiKey: "sk",
      provider: "openai",
      model: "gpt-4o-mini",
      baseURL: "https://example.test",
    })

    expect(getProviderModel).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk",
      baseURL: "https://example.test",
    })
  })

  it("defaults provider to openai and model to gpt-4o-mini", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "x" })
    await generateImageCaption("data:image/png;base64,xyz", { apiKey: "sk" })
    expect(getProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-4o-mini" })
    )
  })

  it("uses claude-haiku-4-5 default for anthropic", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "x" })
    await generateImageCaption("data:image/png;base64,xyz", { apiKey: "k", provider: "anthropic" })
    expect(getProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "claude-haiku-4-5" })
    )
  })

  it("uses gemini-2.5-flash default for google", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "x" })
    await generateImageCaption("data:image/png;base64,xyz", { apiKey: "k", provider: "google" })
    expect(getProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", model: "gemini-2.5-flash" })
    )
  })

  it("constructs a multimodal user message with the image part", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "a green leaf" })

    await generateImageCaption("data:image/png;base64,xyz", { apiKey: "k" })

    const args = generateText.mock.calls[0][0]
    expect(args.messages).toHaveLength(1)
    expect(args.messages[0].role).toBe("user")
    expect(args.messages[0].content).toEqual([
      { type: "text", text: expect.stringMatching(/describe this image/i) },
      { type: "image", image: "data:image/png;base64,xyz" },
    ])
  })

  it("respects a custom prompt", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "ok" })
    await generateImageCaption("data:image/png;base64,xyz", {
      apiKey: "k",
      prompt: "Two-word caption",
    })
    const args = generateText.mock.calls[0][0]
    expect(args.messages[0].content[0]).toEqual({ type: "text", text: "Two-word caption" })
  })

  it("respects maxTokens override (default 200)", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "ok" })

    await generateImageCaption("data:image/png;base64,xyz", { apiKey: "k", maxTokens: 50 })
    expect(generateText.mock.calls[0][0].maxOutputTokens).toBe(50)

    await generateImageCaption("data:image/png;base64,xyz", { apiKey: "k" })
    expect(generateText.mock.calls[1][0].maxOutputTokens).toBe(200)
  })

  it("returns the trimmed caption", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "  a brown dog  \n" })
    const out = await generateImageCaption("data:image/png;base64,xyz", { apiKey: "k" })
    expect(out).toBe("a brown dog")
  })

  it("supports Uint8Array image input", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "ok" })
    const buf = new Uint8Array([1, 2, 3])
    await generateImageCaption(buf, { apiKey: "k" })
    expect(generateText.mock.calls[0][0].messages[0].content[1]).toEqual({
      type: "image",
      image: buf,
    })
  })

  it("supports ArrayBuffer image input", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "ok" })
    const buf = new ArrayBuffer(8)
    await generateImageCaption(buf, { apiKey: "k" })
    expect(generateText.mock.calls[0][0].messages[0].content[1].image).toBe(buf)
  })

  it("rejects when apiKey is missing", async () => {
    await expect(generateImageCaption("data:image/png;base64,xyz", { apiKey: "" })).rejects.toThrow(
      /apiKey is required/
    )
  })

  it("throws when the model returns empty text", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockResolvedValue({ text: "   " })
    await expect(
      generateImageCaption("data:image/png;base64,xyz", { apiKey: "k" })
    ).rejects.toThrow(/empty text/)
  })

  it("throws when generateText throws (propagates provider errors)", async () => {
    getProviderModel.mockReturnValue({})
    generateText.mockRejectedValue(new Error("vision quota exceeded"))
    await expect(
      generateImageCaption("data:image/png;base64,xyz", { apiKey: "k" })
    ).rejects.toThrow(/vision quota exceeded/)
  })
})
