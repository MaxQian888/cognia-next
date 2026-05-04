/**
 * Coverage for the External Bridge permission gate. Drives the "default
 * deny" semantics that protect user content from accidental exposure.
 */

import type { ExternalBridgeSettings } from "@/types/wiki"
import {
  checkRuntimeCall,
  checkScope,
  checkToolCall,
  requiredScopeForRuntimeEntity,
  requiredScopeForTool,
} from "./permission-gate"

function settings(overrides: Partial<ExternalBridgeSettings> = {}): ExternalBridgeSettings {
  return {
    enabled: overrides.enabled ?? true,
    enabledScopes: overrides.enabledScopes ?? ["wiki:cognia", "rag:cognia"],
    bearerToken: overrides.bearerToken,
    httpPort: overrides.httpPort,
    tokenRotatedAt: overrides.tokenRotatedAt,
  }
}

describe("checkScope", () => {
  it("denies when settings is undefined (default deny)", () => {
    const result = checkScope(undefined, "wiki:cognia")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/not configured/)
  })

  it("denies when bridge is disabled even if scope is whitelisted", () => {
    const result = checkScope(settings({ enabled: false }), "wiki:cognia")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/disabled/)
  })

  it("denies when scope is not in the whitelist", () => {
    const result = checkScope(settings({ enabledScopes: ["wiki:cognia"] }), "runtime:skills")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/runtime:skills/)
  })

  it("allows when scope is in the whitelist and bridge is enabled", () => {
    expect(checkScope(settings(), "wiki:cognia")).toEqual({ allowed: true })
  })
})

describe("requiredScopeForTool", () => {
  it("returns the registered scope for known tools", () => {
    expect(requiredScopeForTool("wiki_search")).toBe("wiki:cognia")
    expect(requiredScopeForTool("wiki_read")).toBe("wiki:cognia")
    expect(requiredScopeForTool("rag_search")).toBe("rag:cognia")
  })

  it("returns undefined for unknown tools", () => {
    expect(requiredScopeForTool("does_not_exist")).toBeUndefined()
  })
})

describe("checkToolCall", () => {
  it("denies unknown tools", () => {
    const result = checkToolCall(settings(), "frobnicate")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/unknown tool/)
  })

  it("delegates to checkScope for known tools", () => {
    expect(checkToolCall(settings(), "wiki_search").allowed).toBe(true)
    expect(checkToolCall(settings({ enabledScopes: [] }), "wiki_search").allowed).toBe(false)
  })

  it("denies known tools when bridge is undefined", () => {
    expect(checkToolCall(undefined, "wiki_search").allowed).toBe(false)
  })
})

describe("requiredScopeForRuntimeEntity / checkRuntimeCall", () => {
  it("maps each known entity type", () => {
    expect(requiredScopeForRuntimeEntity("skill")).toBe("runtime:skills")
    expect(requiredScopeForRuntimeEntity("character")).toBe("runtime:characters")
    expect(requiredScopeForRuntimeEntity("twin")).toBe("runtime:twins")
    expect(requiredScopeForRuntimeEntity("plugin")).toBe("runtime:plugins")
    expect(requiredScopeForRuntimeEntity("agent-team")).toBe("runtime:agent-teams")
  })

  it("returns undefined for unknown entity types", () => {
    expect(requiredScopeForRuntimeEntity("widget")).toBeUndefined()
  })

  it("checkRuntimeCall denies unknown entity types", () => {
    const result = checkRuntimeCall(settings(), "widget")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/unknown runtime entity/)
  })

  it("checkRuntimeCall denies entities whose scope is OFF", () => {
    const result = checkRuntimeCall(settings({ enabledScopes: ["wiki:cognia"] }), "skill")
    expect(result.allowed).toBe(false)
  })

  it("checkRuntimeCall allows when entity scope is enabled", () => {
    const result = checkRuntimeCall(settings({ enabledScopes: ["runtime:skills"] }), "skill")
    expect(result.allowed).toBe(true)
  })
})
