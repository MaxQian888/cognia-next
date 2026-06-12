/**
 * @jest-environment node
 */
import {
  buildPluginDocument,
  pluginList,
  pluginSetEnabled,
  pluginShow,
  pluginTools,
} from "./plugin-controller"
import type { PluginInfo, PluginToolInfo } from "../../plugin/discover-plugins"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const plugin = (id: string, supported = true, tools: PluginToolInfo[] = []): PluginInfo => ({
  id,
  name: id,
  version: "1.0.0",
  description: `the ${id}`,
  type: supported ? "frontend" : "python",
  dir: `/p/${id}`,
  supported,
  tools,
  mcpServerPresets: [],
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

describe("buildPluginDocument", () => {
  it("renders header, runnability, and a tool summary with the schema hint", () => {
    const doc = buildPluginDocument(
      plugin("web-tools", true, [
        { name: "web_fetch", description: "Fetch a URL", parametersSchema: { type: "object" } },
      ]),
      true
    )
    expect(doc).toContain("# web-tools")
    expect(doc).toContain("`web-tools`")
    expect(doc).toContain("runnable in CLI")
    expect(doc).toContain("**Tools (1):** web_fetch")
    expect(doc).toContain("/plugin tools web-tools")
  })

  it("notes when a plugin declares no tools", () => {
    const doc = buildPluginDocument(plugin("x"), false)
    expect(doc).toContain("declares no agent tools")
  })
})

describe("pluginShow", () => {
  it("opens a markdown document with manifest details", async () => {
    const { dispatch, actions } = recorder()
    await pluginShow("b", { ...base, dispatch, list: async () => [plugin("b", false)] })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "Plugin · b" },
    })
    expect((actions[0] as { overlay: { body: string } }).overlay.body).toContain(
      "not runnable in CLI"
    )
  })
  it("notices a missing plugin", async () => {
    const { dispatch, actions } = recorder()
    await pluginShow("ghost", { ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("pluginTools", () => {
  it("opens a tool document with each declared tool's schema", async () => {
    const { dispatch, actions } = recorder()
    await pluginTools("web", {
      ...base,
      dispatch,
      list: async () => [
        plugin("web", true, [
          { name: "web_fetch", description: "Fetch a URL", parametersSchema: { type: "object" } },
        ]),
      ],
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "Tools · web (1)" },
    })
    expect((actions[0] as { overlay: { body: string } }).overlay.body).toContain("### web_fetch")
  })
  it("notices when a plugin declares no tools", async () => {
    const { dispatch, actions } = recorder()
    await pluginTools("x", { ...base, dispatch, list: async () => [plugin("x", true, [])] })
    expect((actions[0] as { message: string }).message).toContain("no agent tools")
  })
  it("notices a missing plugin", async () => {
    const { dispatch, actions } = recorder()
    await pluginTools("ghost", { ...base, dispatch, list: async () => [] })
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
