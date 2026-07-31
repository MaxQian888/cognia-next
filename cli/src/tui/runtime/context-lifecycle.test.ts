/**
 * @jest-environment node
 */
import {
  CONTEXT_FIELD_LIFECYCLE,
  CONTEXT_RESTART_NOTICE,
  fieldsByLayer,
  layerForField,
  requiresReconnect,
} from "./context-lifecycle"

describe("CONTEXT_FIELD_LIFECYCLE", () => {
  it("classifies every field exactly once", () => {
    const names = CONTEXT_FIELD_LIFECYCLE.map((e) => e.field)
    expect(new Set(names).size).toBe(names.length)
  })

  it("explains every classification — a table with no reason cannot be audited", () => {
    for (const entry of CONTEXT_FIELD_LIFECYCLE) {
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  it("puts the per-message fields on the turn layer", () => {
    expect(fieldsByLayer("turn")).toEqual(["Twin context", "Attachments"])
  })

  it("puts everything session/new consumes on the session layer", () => {
    expect(fieldsByLayer("session")).toEqual([
      "System prompt",
      "Agent mode",
      "Skills",
      "Output style",
      "MCP servers",
      "Cognia tools",
      "Plugin tools",
      "Working roots",
    ])
  })

  it("puts the Codex connect-time metadata on the connect layer", () => {
    expect(fieldsByLayer("connect")).toEqual(["Thinking level", "External skill roots"])
  })

  it("keeps permission mode and model live — a switch must not discard the thread", () => {
    expect(layerForField("Permission mode")).toBe("live")
    expect(layerForField("Model")).toBe("live")
  })
})

describe("layerForField", () => {
  it("returns undefined for a field that is not classified", () => {
    expect(layerForField("Nonexistent")).toBeUndefined()
  })
})

describe("requiresReconnect", () => {
  it("is true only for connect-layer fields", () => {
    expect(requiresReconnect("Thinking level")).toBe(true)
    expect(requiresReconnect("External skill roots")).toBe(true)
    expect(requiresReconnect("Skills")).toBe(false)
    expect(requiresReconnect("Permission mode")).toBe(false)
    expect(requiresReconnect("Nonexistent")).toBe(false)
  })
})

describe("CONTEXT_RESTART_NOTICE", () => {
  it("says what restarts AND what is kept", () => {
    expect(CONTEXT_RESTART_NOTICE).toMatch(/restarting/i)
    expect(CONTEXT_RESTART_NOTICE).toMatch(/transcript is kept/i)
  })
})
