import { createExternalAgentUiState, reduceExternalAgentUiState } from "./extension-ui-state"
import type { ExternalAgentUiUpdate } from "@/types/agent/external-agent"
const event = (update: ExternalAgentUiUpdate, id = "one") => ({
  type: "extension_ui_update" as const,
  id,
  update,
  timestamp: new Date(0),
})

describe("extension presentation state", () => {
  it("replaces and removes keyed status and widget state without mutating prior state", () => {
    const first = reduceExternalAgentUiState(
      createExternalAgentUiState(),
      event({ kind: "status", key: "a", text: "old" })
    )
    const second = reduceExternalAgentUiState(
      first,
      event({ kind: "status", key: "a", text: "new" })
    )
    expect(first.statuses.a).toBe("old")
    expect(second.statuses).toEqual({ a: "new" })
    expect(
      reduceExternalAgentUiState(second, event({ kind: "status", key: "a", text: null })).statuses
    ).toEqual({})
    const widget = reduceExternalAgentUiState(
      first,
      event({ kind: "widget", key: "a", lines: ["one", "two"], placement: "belowEditor" })
    )
    expect(widget.widgets.a).toEqual({ lines: ["one", "two"], placement: "belowEditor" })
    expect(
      reduceExternalAgentUiState(
        widget,
        event({ kind: "widget", key: "a", lines: null, placement: "aboveEditor" })
      ).widgets
    ).toEqual({})
  })
  it("preserves empty editor replacement and deduplicates bounded notifications", () => {
    const state = reduceExternalAgentUiState(
      createExternalAgentUiState(),
      event({ kind: "editor", text: "" })
    )
    expect(state.editor).toEqual({ id: "one", text: "" })
    const notice = event({ kind: "notification", level: "error", message: "failed" })
    const next = reduceExternalAgentUiState(state, notice)
    expect(reduceExternalAgentUiState(next, notice)).toBe(next)
    let bounded = next
    for (let i = 0; i < 60; i++)
      bounded = reduceExternalAgentUiState(bounded, { ...notice, id: String(i) })
    expect(bounded.notifications).toHaveLength(50)
    expect(reduceExternalAgentUiState(state, event({ kind: "title", title: "window" })).title).toBe(
      "window"
    )
  })
  it("treats prototype-shaped keys as plain extension data", () => {
    const state = reduceExternalAgentUiState(
      createExternalAgentUiState(),
      event({ kind: "status", key: "__proto__", text: "safe" })
    )
    expect(Object.getPrototypeOf(state.statuses)).toBe(Object.prototype)
    expect(Object.entries(state.statuses)).toEqual([["__proto__", "safe"]])
  })
})
