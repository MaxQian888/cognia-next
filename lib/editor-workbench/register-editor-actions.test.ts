import { registerEditorActions, type EditorActionDef } from "./register-editor-actions"
import { registerCommand, __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"

const KeyMod = {
  CtrlCmd: 2048,
  Shift: 1024,
  Alt: 512,
  chord: (a: number, b: number) => a | (b << 16),
}
const KeyCode: Record<string, number> = {
  KeyF: 36,
  KeyP: 46,
  KeyK: 41,
}
const monaco = { KeyMod, KeyCode }

interface AddActionArg {
  id: string
  label: string
  keybindings: number[]
  contextMenuGroupId?: string
  contextMenuOrder?: number
  run: (ed: unknown) => void
}

function makeEditor() {
  const registered: AddActionArg[] = []
  const trigger = jest.fn()
  const editor = {
    trigger,
    addAction: (arg: AddActionArg) => {
      registered.push(arg)
      return { dispose: jest.fn() }
    },
  }
  return { editor, registered, trigger }
}

beforeEach(() => {
  __resetCommandRegistryForTesting()
})

describe("registerEditorActions", () => {
  const actions: EditorActionDef[] = [
    {
      id: "editor.format",
      label: "Format",
      monacoCommand: "editor.action.formatDocument",
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1,
      alwaysAvailable: true,
    },
    {
      id: "file.copyPath",
      label: "Copy Path",
      run: jest.fn(),
      contextMenuGroupId: "9_cutcopypaste",
      alwaysAvailable: true,
    },
  ]

  it("returns [] when editor or monaco is unusable", () => {
    expect(registerEditorActions({}, monaco, { idPrefix: "x.", bindings: {}, actions })).toEqual([])
    expect(
      registerEditorActions(makeEditor().editor, null, { idPrefix: "x.", bindings: {}, actions })
    ).toEqual([])
  })

  it("registers always-available actions with no binding, prefixed + grouped", () => {
    const { editor, registered } = makeEditor()
    const disposables = registerEditorActions(editor, monaco, {
      idPrefix: "proj.",
      bindings: {},
      actions,
    })
    expect(disposables).toHaveLength(2)
    const fmt = registered.find((a) => a.id === "proj.editor.format")
    expect(fmt).toMatchObject({
      label: "Format",
      keybindings: [],
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1,
    })
  })

  it("prefers a localized label from opts.labels over def.label", () => {
    const { editor, registered } = makeEditor()
    registerEditorActions(editor, monaco, {
      idPrefix: "proj.",
      bindings: {},
      labels: { "editor.format": "格式化文档" },
      actions,
    })
    expect(registered.find((a) => a.id === "proj.editor.format")?.label).toBe("格式化文档")
  })

  it("attaches a resolved keybinding when the user bound the action", () => {
    const { editor, registered } = makeEditor()
    registerEditorActions(editor, monaco, {
      idPrefix: "proj.",
      bindings: { "editor.format": "Ctrl+F" },
      actions,
    })
    expect(registered.find((a) => a.id === "proj.editor.format")?.keybindings).toEqual([
      KeyMod.CtrlCmd | KeyCode.KeyF,
    ])
  })

  it("runs the custom run when provided, else triggers the monaco command", () => {
    const { editor, registered, trigger } = makeEditor()
    registerEditorActions(editor, monaco, {
      idPrefix: "proj.",
      triggerSource: "proj-src",
      bindings: {},
      actions,
    })
    registered.find((a) => a.id === "proj.editor.format")?.run(editor)
    expect(trigger).toHaveBeenCalledWith("proj-src", "editor.action.formatDocument", null)
    registered.find((a) => a.id === "proj.file.copyPath")?.run(editor)
    expect(actions[1]?.run).toHaveBeenCalled()
  })

  describe("canvas model (alwaysAvailable falsy)", () => {
    const canvasActions: EditorActionDef[] = [
      { id: "canvas.find", label: "Find", monacoCommand: "actions.find" },
    ]

    it("skips an action with no binding", () => {
      const { editor, registered } = makeEditor()
      const d = registerEditorActions(editor, monaco, {
        idPrefix: "canvas.kb.",
        bindings: {},
        actions: canvasActions,
      })
      expect(d).toHaveLength(0)
      expect(registered).toHaveLength(0)
    })

    it("skips an action whose combo cannot be resolved", () => {
      const { editor, registered } = makeEditor()
      registerEditorActions(editor, monaco, {
        idPrefix: "canvas.kb.",
        bindings: { "canvas.find": "Ctrl+Shift" }, // modifier-only → null
        actions: canvasActions,
      })
      expect(registered).toHaveLength(0)
    })
  })

  describe("plugin commands → F1 palette", () => {
    it("registers only plugin-owned, non-internal commands with no context menu", () => {
      registerCommand({
        id: "myplugin.doThing",
        title: "Do Thing",
        category: "MyPlugin",
        pluginId: "myplugin",
        handler: jest.fn(),
      })
      registerCommand({
        id: "_internal.hidden",
        title: "Hidden",
        pluginId: "myplugin",
        handler: jest.fn(),
      })
      registerCommand({
        id: "cognia.native",
        title: "Native",
        pluginId: null,
        handler: jest.fn(),
      })
      const { editor, registered } = makeEditor()
      registerEditorActions(editor, monaco, {
        idPrefix: "proj.",
        bindings: {},
        actions: [],
        includePluginCommands: true,
      })
      const pluginActions = registered.filter((a) => a.id.startsWith("plugin.cmd."))
      expect(pluginActions).toHaveLength(1)
      expect(pluginActions[0]).toMatchObject({
        id: "plugin.cmd.myplugin.doThing",
        label: "MyPlugin: Do Thing",
      })
      // Palette-only: never injected into the right-click context menu.
      expect(pluginActions[0]).not.toHaveProperty("contextMenuGroupId")
    })

    it("executes the command when the palette action runs", async () => {
      const handler = jest.fn()
      registerCommand({ id: "p.run", title: "Run", pluginId: "p", handler })
      const { editor, registered } = makeEditor()
      registerEditorActions(editor, monaco, {
        idPrefix: "proj.",
        bindings: {},
        actions: [],
        includePluginCommands: true,
      })
      registered.find((a) => a.id === "plugin.cmd.p.run")?.run(editor)
      await Promise.resolve()
      expect(handler).toHaveBeenCalled()
    })
  })
})
