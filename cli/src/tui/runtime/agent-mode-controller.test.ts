import { agentModeList, type AgentModeDeps } from "./agent-mode-controller"
import { customModeToConfig } from "../../config/agent-mode"
import type { TuiAction } from "../state/types"

function collect() {
  const actions: TuiAction[] = []
  const dispatch = (a: TuiAction) => actions.push(a)
  return { actions, dispatch }
}

const baseDeps = (over: Partial<AgentModeDeps> = {}): AgentModeDeps => ({
  dispatch: () => {},
  cwd: "/proj",
  listCustom: async () => [],
  ...over,
})

describe("agentModeList", () => {
  it("opens a select overlay with built-ins + custom modes and the onSelectCommand", async () => {
    const { actions, dispatch } = collect()
    await agentModeList(
      baseDeps({
        dispatch,
        listCustom: async () => [customModeToConfig("reviewer", { name: "Reviewer" })],
      })
    )
    expect(actions).toHaveLength(1)
    const overlay = (
      actions[0] as { overlay: { kind: string; items: { id: string }[]; onSelectCommand?: string } }
    ).overlay
    expect(overlay.kind).toBe("select")
    expect(overlay.onSelectCommand).toBe("agent-mode")
    const ids = overlay.items.map((i) => i.id)
    expect(ids[0]).toBe("general") // the "(none)" row, surfaced once at the top
    expect(ids).toContain("plan")
    expect(ids).toContain("build")
    expect(ids).toContain("reviewer")
    // general appears exactly once (not duplicated by the built-in catalog row).
    expect(ids.filter((id) => id === "general")).toHaveLength(1)
  })

  it("marks the active mode and tags custom modes", async () => {
    const { actions, dispatch } = collect()
    await agentModeList(
      baseDeps({
        dispatch,
        activeModeId: "plan",
        listCustom: async () => [customModeToConfig("reviewer", { name: "Reviewer" })],
      })
    )
    const items = (actions[0] as { overlay: { items: { id: string; hint?: string }[] } }).overlay
      .items
    expect(items.find((i) => i.id === "plan")?.hint).toBe("current")
    expect(items.find((i) => i.id === "reviewer")?.hint).toBe("custom")
    expect(items.find((i) => i.id === "general")?.hint).toBeUndefined()
  })

  it("marks (none) as current when no mode is active", async () => {
    const { actions, dispatch } = collect()
    await agentModeList(baseDeps({ dispatch }))
    const items = (actions[0] as { overlay: { items: { id: string; hint?: string }[] } }).overlay
      .items
    expect(items.find((i) => i.id === "general")?.hint).toBe("current")
  })

  it("shows the permission ruleset in the label when a mode declares one", async () => {
    const { actions, dispatch } = collect()
    await agentModeList(baseDeps({ dispatch }))
    const items = (actions[0] as { overlay: { items: { id: string; label: string }[] } }).overlay
      .items
    expect(items.find((i) => i.id === "plan")?.label).toContain("[plan]")
  })
})
