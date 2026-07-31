/**
 * Coverage for the External Bridge permission gate. Drives the "default
 * deny" semantics that protect user content from accidental exposure.
 */

import type { ExternalBridgeSettings } from "@/types/wiki"
import {
  bridgeScopeForRagScope,
  checkRagCall,
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

  it("checkRagCall maps cognia/all/empty to rag:cognia", () => {
    const s = settings({ enabledScopes: ["rag:cognia"] })
    expect(checkRagCall(s, "all").allowed).toBe(true)
    expect(checkRagCall(s, "cognia-self").allowed).toBe(true)
    expect(checkRagCall(s, "").allowed).toBe(true)
  })

  it("checkRagCall denies twin scope by default (rag:twin not enabled)", () => {
    const result = checkRagCall(settings(), "twin")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/rag:twin/)
  })

  it("checkRagCall allows twin scope when rag:twin is in the whitelist", () => {
    const result = checkRagCall(settings({ enabledScopes: ["rag:cognia", "rag:twin"] }), "twin")
    expect(result.allowed).toBe(true)
  })

  it("checkRagCall rejects unknown rag scopes", () => {
    const result = checkRagCall(settings(), "made-up")
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/unknown rag scope/)
  })

  it("checkRagCall allows the 'runtime' scope under rag:cognia (was previously always denied)", () => {
    const s = settings({ enabledScopes: ["rag:cognia"] })
    expect(checkRagCall(s, "runtime").allowed).toBe(true)
  })

  it("checkRagCall maps 'user-repo' to rag:user-repo (default OFF)", () => {
    expect(checkRagCall(settings(), "user-repo").allowed).toBe(false)
    expect(checkRagCall(settings({ enabledScopes: ["rag:user-repo"] }), "user-repo").allowed).toBe(
      true
    )
  })
})

describe("bridgeScopeForRagScope", () => {
  it("maps every known rag scope to its BridgeScope", () => {
    expect(bridgeScopeForRagScope("twin")).toBe("rag:twin")
    expect(bridgeScopeForRagScope("user-repo")).toBe("rag:user-repo")
    expect(bridgeScopeForRagScope("cognia-self")).toBe("rag:cognia")
    expect(bridgeScopeForRagScope("runtime")).toBe("rag:cognia")
    expect(bridgeScopeForRagScope("all")).toBe("rag:cognia")
    expect(bridgeScopeForRagScope(undefined)).toBe("rag:cognia")
    expect(bridgeScopeForRagScope("")).toBe("rag:cognia")
  })

  it("returns undefined for an unknown scope so the caller can deny", () => {
    expect(bridgeScopeForRagScope("made-up")).toBeUndefined()
  })
})
