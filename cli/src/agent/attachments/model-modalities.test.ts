/**
 * @jest-environment node
 */
import {
  modelSupportsImageInput,
  modelSupportsPdfInput,
  modelInputModalities,
} from "./model-modalities"

describe("modelSupportsPdfInput", () => {
  it("is true for a Claude model (provider+model in the snapshot)", () => {
    expect(modelSupportsPdfInput("anthropic", "claude-opus-4-5")).toBe(true)
  })

  it("is true for a Gemini model", () => {
    expect(modelSupportsPdfInput("google", "gemini-2.5-pro")).toBe(true)
  })

  it("resolves an org/model style id", () => {
    expect(modelInputModalities("openrouter", "google/gemini-2.5-pro")).toContain("pdf")
  })

  it("splits an org/model id when the provider has no direct entry", () => {
    // "zzz" is not a provider org, so the direct lookup misses and the org-split
    // path resolves "google" / "gemini-2.5-pro".
    expect(modelInputModalities("zzz", "google/gemini-2.5-pro")).toContain("pdf")
  })

  it("falls back to a bare model-id match under any provider org", () => {
    // Wrong provider + no slash → the last-resort scan finds the model id.
    expect(modelInputModalities("not-a-provider", "claude-opus-4-5")).toContain("pdf")
  })

  it("is false for an unknown model", () => {
    expect(modelSupportsPdfInput("acme", "totally-made-up-9000")).toBe(false)
  })
})

describe("modelSupportsImageInput", () => {
  it("is true for a vision model", () => {
    expect(modelSupportsImageInput("anthropic", "claude-opus-4-5")).toBe(true)
    expect(modelSupportsImageInput("google", "gemini-2.5-pro")).toBe(true)
  })

  it("is false for a text-only model", () => {
    expect(modelSupportsImageInput("deepseek", "deepseek-chat")).toBe(false)
  })

  it("is false for an unknown model", () => {
    expect(modelSupportsImageInput("acme", "totally-made-up-9000")).toBe(false)
  })
})
