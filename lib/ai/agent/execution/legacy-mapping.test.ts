import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  executionKindFromTools,
  routePolicyFromProxyMode,
  runtimeFromLegacy,
} from "./legacy-mapping"

describe("runtimeFromLegacy", () => {
  it("maps anthropic and the undefined default to claude-agent-sdk", () => {
    expect(runtimeFromLegacy({ provider: "anthropic" })).toBe("claude-agent-sdk")
    expect(runtimeFromLegacy({})).toBe("claude-agent-sdk")
  })

  it("maps every non-anthropic provider id — including anthropic-relay ids — to ai-sdk", () => {
    // Relay fixtures: under R5, `family: "anthropic-native"` is NOT
    // compatibility evidence, so relays behave like any other provider id.
    const providers = [
      "openai",
      "google",
      "openrouter",
      "glm-anthropic",
      "glm-anthropic-intl",
      "kimi-anthropic",
      "minimax-anthropic",
      "deepseek-anthropic",
      "custom-abc123",
    ]
    for (const provider of providers) {
      expect(runtimeFromLegacy({ provider })).toBe("ai-sdk")
    }
  })

  it("maps non-claude teammate runtimes to external regardless of provider", () => {
    expect(runtimeFromLegacy({ teammateRuntime: "codex" })).toBe("external")
    expect(runtimeFromLegacy({ teammateRuntime: "opencode", provider: "anthropic" })).toBe(
      "external"
    )
    expect(runtimeFromLegacy({ teammateRuntime: "claude" })).toBe("claude-agent-sdk")
    expect(runtimeFromLegacy({ teammateRuntime: "claude", provider: "openai" })).toBe("ai-sdk")
  })

  it("contains no provider-name special case in the implementation", () => {
    // The mapping must be structural (anthropic vs everything else), never a
    // vendor table. Guard the source itself so a future "helpful" special
    // case fails loudly.
    const source = readFileSync(join(__dirname, "legacy-mapping.ts"), "utf8")
    for (const vendor of ["glm", "kimi", "zhipu", "moonshot", "minimax", "deepseek"]) {
      const codeLines = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n")
      expect(codeLines.toLowerCase()).not.toContain(vendor)
    }
  })
})

describe("routePolicyFromProxyMode", () => {
  const desktop = { isHeadlessManaged: false }
  const headless = { isHeadlessManaged: true }

  it("maps the three explicit modes verbatim", () => {
    expect(routePolicyFromProxyMode("always", desktop)).toBe("gateway-required")
    expect(routePolicyFromProxyMode("preferred", desktop)).toBe("gateway-preferred")
    expect(routePolicyFromProxyMode("never", desktop)).toBe("direct")
    // Explicit modes win over environment defaults.
    expect(routePolicyFromProxyMode("never", headless)).toBe("direct")
  })

  it("defaults to gateway-preferred on desktop, gateway-required on headless/managed", () => {
    expect(routePolicyFromProxyMode(undefined, desktop)).toBe("gateway-preferred")
    expect(routePolicyFromProxyMode(undefined, headless)).toBe("gateway-required")
  })
})

describe("executionKindFromTools", () => {
  it("explicit policy ⇒ agent / no fallback / not migrated", () => {
    expect(executionKindFromTools({ hasExplicitPolicy: true, toolsEnabled: true })).toEqual({
      executionKind: "agent",
      fallbackPolicy: "none",
      legacyMigrated: false,
    })
  })

  it("toolsEnabled: false ⇒ intentional completion", () => {
    expect(executionKindFromTools({ toolsEnabled: false })).toEqual({
      executionKind: "completion",
      fallbackPolicy: "none",
      legacyMigrated: false,
    })
  })

  it("toolsEnabled absent (legacy text caller) ⇒ intentional completion", () => {
    expect(executionKindFromTools({})).toEqual({
      executionKind: "completion",
      fallbackPolicy: "none",
      legacyMigrated: false,
    })
  })

  it("toolsEnabled + requireTools ⇒ required tools, fail closed", () => {
    expect(executionKindFromTools({ toolsEnabled: true, requireTools: true })).toEqual({
      executionKind: "agent",
      fallbackPolicy: "none",
      legacyMigrated: false,
    })
  })

  it("legacy toolsEnabled without requireTools ⇒ explicit completion fallback + legacyMigrated", () => {
    expect(executionKindFromTools({ toolsEnabled: true })).toEqual({
      executionKind: "agent",
      fallbackPolicy: "completion",
      legacyMigrated: true,
    })
    expect(executionKindFromTools({ toolsEnabled: true, requireTools: false })).toEqual({
      executionKind: "agent",
      fallbackPolicy: "completion",
      legacyMigrated: true,
    })
  })
})
