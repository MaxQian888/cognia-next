/**
 * @jest-environment node
 */
import { pluginList, pluginSetEnabled, pluginShow } from "./plugin-controller"
import type { PluginInfo } from "../../plugin/discover-plugins"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const plugin = (id: string, supported = true): PluginInfo => ({
  id,
  name: id,
  version: "1.0.0",
  description: `the ${id}`,
  type: supported ? "frontend" : "python",
  dir: `/p/${id}`,
  supported,
})

const base = { roots: ["/w"], home: "/home" }

describe("pluginList", () => {
  it("opens a select overlay with type/supported/enabled hints", async () => {
    const { dispatch, actions } = recorder()
    await pluginList({
      ...base,
      dispatch,
      list: async () => [plugin("a", true), plugin("b", false)],
      getDisabled: () => new Set(["a"]),
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "plugin show",
        items: [
          { id: "a", hint: "frontend · off" },
          { id: "b", hint: "python · unsupported · on" },
        ],
      },
    })
  })

  it("notices when none are installed", async () => {
    const { dispatch, actions } = recorder()
    await pluginList({ ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No plugins")
  })
})

describe("pluginShow", () => {
  it("notices manifest details + CLI runnability", async () => {
    const { dispatch, actions } = recorder()
    await pluginShow("b", { ...base, dispatch, list: async () => [plugin("b", false)] })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("python")
    expect(msg).toContain("not runnable in CLI")
  })
  it("notices a missing plugin", async () => {
    const { dispatch, actions } = recorder()
    await pluginShow("ghost", { ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("pluginSetEnabled", () => {
  it("maps enabled→not-disabled", () => {
    let captured: { id: string; disabled: boolean } | null = null
    pluginSetEnabled("a", false, {
      ...base,
      dispatch: () => {},
      setEnabled: (id, disabled) => {
        captured = { id, disabled }
      },
    })
    expect(captured).toEqual({ id: "a", disabled: true })
  })
})
