import { registerCanvasEditorActions } from "./register-canvas-editor-actions"

const updateEditorSettings = jest.fn()
let editorSettings = { wordWrap: false, minimap: true }

jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: {
    getState: () => ({
      settings: { editor: editorSettings },
      updateEditorSettings,
    }),
  },
}))

const KeyMod = {
  CtrlCmd: 2048,
  Shift: 1024,
  Alt: 512,
  chord: (a: number, b: number) => a | (b << 16),
}
const KeyCode: Record<string, number> = {
  KeyF: 36,
  KeyH: 38,
  KeyG: 37,
  KeyD: 34,
  KeyM: 44,
  KeyZ: 56,
  Digit0: 21,
  Digit1: 22,
  Digit2: 23,
  Slash: 85,
  BracketRight: 88,
}
const monaco = { KeyMod, KeyCode }

interface AddActionArg {
  id: string
  label: string
  keybindings: number[]
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

describe("registerCanvasEditorActions", () => {
  beforeEach(() => {
    updateEditorSettings.mockClear()
    editorSettings = { wordWrap: false, minimap: true }
  })

  it("registers editor-scoped commands with the stored keybinding", () => {
    const { editor, registered } = makeEditor()
    const disposables = registerCanvasEditorActions(editor, monaco, {
      "canvas.find": "Ctrl+F",
      "canvas.format": "Shift+Alt+F",
    })

    const find = registered.find((a) => a.id === "canvas.kb.canvas.find")
    expect(find).toBeDefined()
    expect(find?.keybindings).toEqual([KeyMod.CtrlCmd | KeyCode.KeyF])
    expect(disposables).toHaveLength(2)
  })

  it("does NOT register app-level or clipboard bindings", () => {
    const { editor, registered } = makeEditor()
    registerCanvasEditorActions(editor, monaco, {
      "canvas.save": "Ctrl+S",
      "edit.copy": "Ctrl+C",
      "edit.cut": "Ctrl+X",
      "edit.selectAll": "Ctrl+A",
    })
    expect(registered).toHaveLength(0)
  })

  it("triggers the mapped Monaco command when the action runs", () => {
    const { editor, registered, trigger } = makeEditor()
    registerCanvasEditorActions(editor, monaco, { "canvas.goToLine": "Ctrl+G" })
    const action = registered.find((a) => a.id === "canvas.kb.canvas.goToLine")
    action?.run(editor)
    expect(trigger).toHaveBeenCalledWith("canvas-keybinding", "editor.action.gotoLine", null)
  })

  it("wires the net-new word-wrap / minimap toggles to the settings store", () => {
    const { editor, registered } = makeEditor()
    registerCanvasEditorActions(editor, monaco, {
      "canvas.toggleWordWrap": "Alt+Z",
      "canvas.toggleMinimap": "Ctrl+Shift+M",
    })
    const wrap = registered.find((a) => a.id === "canvas.kb.canvas.toggleWordWrap")
    expect(wrap).toBeDefined()
    wrap?.run(editor)
    expect(updateEditorSettings).toHaveBeenCalledWith({ wordWrap: true })
  })

  it("skips bindings whose combo cannot be resolved", () => {
    const { editor, registered } = makeEditor()
    registerCanvasEditorActions(editor, monaco, {
      "canvas.find": "Ctrl+Shift", // modifier-only → unresolvable
    })
    expect(registered.find((a) => a.id === "canvas.kb.canvas.find")).toBeUndefined()
  })

  it("returns [] when the editor cannot register actions", () => {
    expect(registerCanvasEditorActions({}, monaco, { "canvas.find": "Ctrl+F" })).toEqual([])
    expect(
      registerCanvasEditorActions(makeEditor().editor, null, { "canvas.find": "Ctrl+F" })
    ).toEqual([])
  })
})
