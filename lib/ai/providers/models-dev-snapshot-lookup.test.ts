/**
 * @jest-environment node
 */
import {
  lookupSnapshotModel,
  snapshotInputModalities,
  snapshotModelReasoning,
} from "@/lib/ai/providers/models-dev-snapshot-lookup"

describe("lookupSnapshotModel", () => {
  it("resolves a model by its owning provider org", () => {
    expect(lookupSnapshotModel("anthropic", "claude-sonnet-4-5")).toBeDefined()
  })

  it("resolves a gateway-style org/model id when the provider has no direct entry", () => {
    expect(lookupSnapshotModel("openrouter", "google/gemini-2.5-pro")).toBeDefined()
  })

  it("falls back to a bare model-id match under any provider org", () => {
    expect(lookupSnapshotModel("not-a-provider", "claude-sonnet-4-5")).toBeDefined()
  })

  it("returns undefined for an unknown model", () => {
    expect(lookupSnapshotModel("acme", "totally-made-up-9000")).toBeUndefined()
  })
})

describe("snapshotModelReasoning", () => {
  it("is true for a reasoning model", () => {
    expect(snapshotModelReasoning("openai", "o1")).toBe(true)
    expect(snapshotModelReasoning("deepseek", "deepseek-reasoner")).toBe(true)
  })

  it("is false for a non-reasoning model the snapshot carries", () => {
    expect(snapshotModelReasoning("openai", "gpt-4o")).toBe(false)
    expect(snapshotModelReasoning("deepseek", "deepseek-chat")).toBe(false)
  })

  it("is undefined for a model the snapshot doesn't carry", () => {
    expect(snapshotModelReasoning("openai", "totally-made-up-9000")).toBeUndefined()
  })
})

describe("snapshotInputModalities", () => {
  it("returns the declared input modalities for a vision model", () => {
    const mods = snapshotInputModalities("google", "gemini-2.5-pro")
    expect(mods).toContain("image")
    expect(mods).toContain("pdf")
  })

  it("returns text-only for a text model", () => {
    expect(snapshotInputModalities("deepseek", "deepseek-chat")).toEqual(["text"])
  })

  it("returns [] for an unknown model", () => {
    expect(snapshotInputModalities("acme", "totally-made-up-9000")).toEqual([])
  })
})
