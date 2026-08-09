/**
 * Unit tests for `cli/src/x/model-selector.ts`.
 */

import { getDefaultModels, selectModel } from "./model-selector"

describe("selectModel", () => {
  it("returns remembered model when user presses Enter", async () => {
    const result = await selectModel("claude", "claude-sonnet-4-20250514", {
      readLine: async () => "",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
  })

  it("returns remembered model on null (EOF)", async () => {
    const result = await selectModel("claude", "claude-sonnet-4-20250514", {
      readLine: async () => null,
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
  })

  it("allows overriding remembered model by number", async () => {
    const result = await selectModel("claude", "claude-sonnet-4-20250514", {
      readLine: async () => "2",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-opus-4-20250514")
  })

  it("allows typing a custom model id to override remembered", async () => {
    const result = await selectModel("claude", "claude-sonnet-4-20250514", {
      readLine: async () => "my-custom-model",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("my-custom-model")
  })

  it("shows full picker when no remembered model", async () => {
    let promptText = ""
    const result = await selectModel("codex", undefined, {
      readLine: async (prompt) => {
        promptText = prompt
        return "1"
      },
      models: ["o3", "o4-mini"],
    })
    expect(result).toBe("o3")
    expect(promptText).toContain("Select a model for codex")
    // The numbered items include ANSI color codes, so check for the number alone
    expect(promptText).toContain("1")
    expect(promptText).toContain("2")
  })

  it("defaults to first model when user presses Enter without remembered", async () => {
    const result = await selectModel("claude", undefined, {
      readLine: async () => "",
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
  })

  it("defaults to first model on null (EOF) without remembered", async () => {
    const result = await selectModel("claude", undefined, {
      readLine: async () => null,
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
  })

  it("accepts custom model id from the full picker", async () => {
    const result = await selectModel("claude", undefined, {
      readLine: async () => "custom-model-xyz",
      models: ["claude-sonnet-4-20250514"],
    })
    expect(result).toBe("custom-model-xyz")
  })

  it("skips remembered model not in the list and shows picker", async () => {
    let promptText = ""
    const result = await selectModel("claude", "obsolete-model", {
      readLine: async (prompt) => {
        promptText = prompt
        return "1"
      },
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
    // Should show the full picker since remembered is not in the list
    expect(promptText).toContain("Select a model")
  })
})

describe("getDefaultModels", () => {
  it("returns claude models for claude agent", () => {
    const models = getDefaultModels("claude")
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.includes("claude"))).toBe(true)
  })

  it("returns openai models for codex agent", () => {
    const models = getDefaultModels("codex")
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.includes("o3") || m.includes("gpt") || m.includes("codex"))).toBe(
      true
    )
  })

  it("returns a copy (not a reference) of the internal list", () => {
    const a = getDefaultModels("claude")
    const b = getDefaultModels("claude")
    expect(a).toEqual(b)
    a.push("mutated")
    expect(b).not.toContain("mutated")
  })
})

describe("selectModel (non-TTY)", () => {
  it("auto-selects remembered model when not on TTY", async () => {
    const result = await selectModel("claude", "claude-sonnet-4-20250514", {
      isTTY: false,
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
  })

  it("auto-selects first default when remembered is not in list and not on TTY", async () => {
    const result = await selectModel("claude", "obsolete-model", {
      isTTY: false,
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    })
    expect(result).toBe("claude-sonnet-4-20250514")
  })

  it("auto-selects first default when no remembered model and not on TTY", async () => {
    const result = await selectModel("codex", undefined, {
      isTTY: false,
      models: ["o3", "o4-mini"],
    })
    expect(result).toBe("o3")
  })
})
