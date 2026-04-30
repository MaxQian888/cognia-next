jest.mock("@ai-sdk/anthropic", () => {
  const mockModel = jest.fn((modelId?: string) => ({ provider: "anthropic", modelId }))
  return { __esModule: true, anthropic: mockModel }
})

import { getProviderModel } from "./client"
import { anthropic as mockAnthropic } from "@ai-sdk/anthropic"

describe("getProviderModel", () => {
  beforeEach(() => {
    ;(mockAnthropic as jest.Mock).mockClear()
    delete process.env.ANTHROPIC_API_KEY
  })

  it("creates an anthropic model with the supplied model id", () => {
    const m = getProviderModel({ provider: "anthropic", model: "claude-3-7-haiku" }) as unknown as {
      modelId: string
    }
    expect(m.modelId).toBe("claude-3-7-haiku")
    expect(mockAnthropic).toHaveBeenCalledWith("claude-3-7-haiku")
  })

  it("falls back to claude-sonnet-4-5 when the model is empty", () => {
    getProviderModel({ provider: "anthropic", model: "" })
    expect(mockAnthropic).toHaveBeenCalledWith("claude-sonnet-4-5")
  })

  it("sets ANTHROPIC_API_KEY when an apiKey is supplied and the var is not already set", () => {
    getProviderModel({ provider: "anthropic", model: "x", apiKey: "from-call" })
    expect(process.env.ANTHROPIC_API_KEY).toBe("from-call")
  })

  it("does not overwrite an existing ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "existing"
    getProviderModel({ provider: "anthropic", model: "x", apiKey: "from-call" })
    expect(process.env.ANTHROPIC_API_KEY).toBe("existing")
  })

  it("does not touch process.env when apiKey is omitted", () => {
    process.env.ANTHROPIC_API_KEY = "preserved"
    getProviderModel({ provider: "anthropic", model: "x" })
    expect(process.env.ANTHROPIC_API_KEY).toBe("preserved")
  })

  it("falls back to anthropic for non-anthropic providers (current single-provider implementation)", () => {
    getProviderModel({ provider: "openai" as never, model: "gpt-x" })
    expect(mockAnthropic).toHaveBeenCalledWith("gpt-x")
  })
})
