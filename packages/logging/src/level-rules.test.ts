import type { LogLevel } from "./types"

import { clearLevelRuleCache, resolveMinLevel } from "./level-rules"

const NO_RULES: Record<string, LogLevel> = {}

describe("resolveMinLevel", () => {
  beforeEach(() => {
    clearLevelRuleCache()
  })

  it("falls back to the global level when there are no rules", () => {
    expect(resolveMinLevel("network", NO_RULES, "info")).toBe("info")
  })

  it("falls back to the global level when no rule matches", () => {
    expect(resolveMinLevel("ai", { network: "debug" }, "warn")).toBe("warn")
  })

  it("honors an exact module match", () => {
    expect(resolveMinLevel("network", { network: "debug" }, "info")).toBe("debug")
  })

  it("applies a parent prefix rule to child modules", () => {
    expect(resolveMinLevel("network:lark:handshake", { network: "debug" }, "info")).toBe("debug")
  })

  it("prefers the longest matching prefix", () => {
    const rules: Record<string, LogLevel> = {
      network: "debug",
      "network:lark": "trace",
    }
    expect(resolveMinLevel("network:lark:handshake", rules, "info")).toBe("trace")
  })

  it("does not treat a sibling prefix as a match", () => {
    // "net" is not a hierarchy prefix of "network" (segments differ)
    expect(resolveMinLevel("network", { net: "trace" }, "info")).toBe("info")
  })

  it("respects the provided global fallback", () => {
    expect(resolveMinLevel("ai:agent", NO_RULES, "error")).toBe("error")
  })

  it("ignores empty/whitespace rule keys", () => {
    expect(resolveMinLevel("network", { "": "trace", "  ": "trace" }, "info")).toBe("info")
  })

  it("auto-invalidates when the rules object reference changes", () => {
    expect(resolveMinLevel("network", { network: "debug" }, "info")).toBe("debug")
    // New object reference with no rule -> must not return the stale cached value
    expect(resolveMinLevel("network", NO_RULES, "info")).toBe("info")
  })

  it("auto-invalidates when the global fallback changes", () => {
    expect(resolveMinLevel("ai", NO_RULES, "info")).toBe("info")
    expect(resolveMinLevel("ai", NO_RULES, "warn")).toBe("warn")
  })

  it("returns the cached result on a repeated lookup with the same inputs", () => {
    const rules: Record<string, LogLevel> = { network: "debug" }
    expect(resolveMinLevel("network", rules, "info")).toBe("debug")
    // Same module + same rules reference + same global => served from cache.
    expect(resolveMinLevel("network", rules, "info")).toBe("debug")
  })

  it("skips empty segments in a malformed module name", () => {
    // ":x" splits into ["", "x"]; the empty leading segment must be skipped.
    expect(resolveMinLevel(":x", {}, "warn")).toBe("warn")
    expect(resolveMinLevel("", {}, "error")).toBe("error")
  })

  it("clearLevelRuleCache forces a fresh resolution", () => {
    const rules: Record<string, LogLevel> = { network: "debug" }
    expect(resolveMinLevel("network", rules, "info")).toBe("debug")
    // Mutating the same object in place would normally be hidden by the cache;
    // clearing makes the new value visible.
    rules.network = "trace"
    clearLevelRuleCache()
    expect(resolveMinLevel("network", rules, "info")).toBe("trace")
  })
})
