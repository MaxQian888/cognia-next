/**
 * Tests for strict tool sampling.
 */

import {
  getModelStrictCapability,
  resolveStrictPolicy,
  applyStrictPolicies,
  type ToolStrictDeclaration,
} from "./strict-sampling"

describe("getModelStrictCapability", () => {
  it("returns supported for GPT-4o", () => {
    const cap = getModelStrictCapability("gpt-4o-2024-08-06")
    expect(cap.supported).toBe(true)
    expect(cap.source).toBe("catalog")
  })

  it("returns supported for Claude", () => {
    const cap = getModelStrictCapability("claude-sonnet-4-20250514")
    expect(cap.supported).toBe(true)
  })

  it("returns supported for Gemini 2.5", () => {
    const cap = getModelStrictCapability("gemini-2.5-flash")
    expect(cap.supported).toBe(true)
  })

  it("returns supported for o3", () => {
    const cap = getModelStrictCapability("o3-2025-04-16")
    expect(cap.supported).toBe(true)
  })

  it("returns unknown for unrecognized model", () => {
    const cap = getModelStrictCapability("llama-3.1-70b")
    expect(cap.supported).toBe(false)
    expect(cap.source).toBe("unknown")
  })

  it("returns unknown for undefined model", () => {
    const cap = getModelStrictCapability(undefined)
    expect(cap.supported).toBe(false)
    expect(cap.source).toBe("unknown")
  })
})

describe("resolveStrictPolicy", () => {
  describe("off", () => {
    it("never enables strict", () => {
      const result = resolveStrictPolicy("off", "gpt-4o")
      expect(result.enableStrict).toBe(false)
      expect(result.degradationWarning).toBeUndefined()
      expect(result.preflightError).toBeUndefined()
    })
  })

  describe("prefer", () => {
    it("enables strict when model supports it", () => {
      const result = resolveStrictPolicy("prefer", "gpt-4o", "my_tool")
      expect(result.enableStrict).toBe(true)
      expect(result.degradationWarning).toBeUndefined()
    })

    it("degrades with warning when model does not support strict", () => {
      const result = resolveStrictPolicy("prefer", "llama-3.1-70b", "my_tool")
      expect(result.enableStrict).toBe(false)
      expect(result.degradationWarning).toBeDefined()
      expect(result.degradationWarning!.code).toBe("strict_mode_degraded")
      expect(result.degradationWarning!.message).toContain("my_tool")
    })
  })

  describe("require", () => {
    it("enables strict when model supports it", () => {
      const result = resolveStrictPolicy("require", "claude-sonnet-4-20250514", "read_file")
      expect(result.enableStrict).toBe(true)
      expect(result.preflightError).toBeUndefined()
    })

    it("fails preflight when model does not support strict", () => {
      const result = resolveStrictPolicy("require", "unknown-model-v1", "read_file")
      expect(result.enableStrict).toBe(false)
      expect(result.preflightError).toBeDefined()
      expect(result.preflightError!.code).toBe("unsupported_capability")
      expect(result.preflightError!.message).toContain("read_file")
    })

    it("fails preflight for undefined model", () => {
      const result = resolveStrictPolicy("require", undefined, "execute")
      expect(result.preflightError).toBeDefined()
    })
  })
})

describe("applyStrictPolicies", () => {
  it("processes a mixed batch", () => {
    const declarations: ToolStrictDeclaration[] = [
      { toolName: "read_file", policy: "prefer" },
      { toolName: "write_file", policy: "require" },
      { toolName: "exec", policy: "off" },
    ]
    const result = applyStrictPolicies(declarations, "gpt-4o")
    expect(result.decisions.get("read_file")).toBe(true)
    expect(result.decisions.get("write_file")).toBe(true)
    expect(result.decisions.get("exec")).toBe(false)
    expect(result.warnings).toHaveLength(0)
    expect(result.preflightError).toBeUndefined()
  })

  it("collects warnings from degraded prefer tools", () => {
    const declarations: ToolStrictDeclaration[] = [
      { toolName: "a", policy: "prefer" },
      { toolName: "b", policy: "prefer" },
    ]
    const result = applyStrictPolicies(declarations, "unknown-model")
    expect(result.warnings).toHaveLength(2)
    expect(result.decisions.get("a")).toBe(false)
  })

  it("reports first preflight error from require", () => {
    const declarations: ToolStrictDeclaration[] = [
      { toolName: "a", policy: "require" },
      { toolName: "b", policy: "require" },
    ]
    const result = applyStrictPolicies(declarations, "unknown-model")
    expect(result.preflightError).toBeDefined()
    expect(result.preflightError!.message).toContain("a")
  })

  it("returns empty results for empty declarations", () => {
    const result = applyStrictPolicies([], "gpt-4o")
    expect(result.decisions.size).toBe(0)
    expect(result.warnings).toHaveLength(0)
  })
})
