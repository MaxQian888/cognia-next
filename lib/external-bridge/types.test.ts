/**
 * Coverage for the External Bridge type re-exports + tool/scope maps.
 *
 * The maps drive the permission gate; if a tool name moves or a runtime
 * entity gains a new scope these tests fail loudly so the gate can't fall
 * out of sync with the handler implementations.
 */

import {
  ALL_BRIDGE_SCOPES,
  DEFAULT_ENABLED_SCOPES,
  DEFAULT_EXTERNAL_BRIDGE_SETTINGS,
  RUNTIME_ENTITY_TO_SCOPE,
  TOOL_TO_SCOPE,
  WORKFLOW_MCP_LIFECYCLE_TOOL_NAMES,
} from "./types"

describe("external-bridge types", () => {
  it("ALL_BRIDGE_SCOPES contains every default scope", () => {
    for (const scope of DEFAULT_ENABLED_SCOPES) {
      expect(ALL_BRIDGE_SCOPES).toContain(scope)
    }
  })

  it("DEFAULT_ENABLED_SCOPES is exactly the public-code wiki + RAG pair", () => {
    expect([...DEFAULT_ENABLED_SCOPES].sort()).toEqual(["rag:cognia", "wiki:cognia"])
  })

  it("declares workflow execution as an explicit opt-in scope", () => {
    expect(ALL_BRIDGE_SCOPES).toContain("workflow:run")
    expect(DEFAULT_ENABLED_SCOPES).not.toContain("workflow:run")
    expect(WORKFLOW_MCP_LIFECYCLE_TOOL_NAMES).toEqual([
      "workflow_list",
      "workflow_status",
      "workflow_events",
      "workflow_cancel",
    ])
  })

  it("DEFAULT_EXTERNAL_BRIDGE_SETTINGS starts disabled with default scopes", () => {
    expect(DEFAULT_EXTERNAL_BRIDGE_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_EXTERNAL_BRIDGE_SETTINGS.bearerToken).toBeUndefined()
    expect(DEFAULT_EXTERNAL_BRIDGE_SETTINGS.enabledScopes.sort()).toEqual([
      "rag:cognia",
      "wiki:cognia",
    ])
  })

  it("TOOL_TO_SCOPE maps each declared tool to a known scope", () => {
    for (const [tool, scope] of Object.entries(TOOL_TO_SCOPE)) {
      expect(typeof tool).toBe("string")
      expect(ALL_BRIDGE_SCOPES).toContain(scope)
    }
  })

  it("RUNTIME_ENTITY_TO_SCOPE covers all five runtime entity types", () => {
    expect(Object.keys(RUNTIME_ENTITY_TO_SCOPE).sort()).toEqual([
      "agent-team",
      "character",
      "plugin",
      "skill",
      "twin",
    ])
    for (const scope of Object.values(RUNTIME_ENTITY_TO_SCOPE)) {
      expect(ALL_BRIDGE_SCOPES).toContain(scope)
    }
  })
})
