/** @jest-environment jsdom */

import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  armProjectEditorGoto,
  consumeProjectEditorGoto,
  PROJECT_EDITOR_GOTO_EVENT,
} from "./editor-events"
import { projectEditorGotoExtension, revealLightEditorLine } from "./light-editor-goto"

const DOC = ["line one", "line two", "  indented three", "four"].join("\n")

function mount(relPath: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [projectEditorGotoExtension(relPath)] }),
    parent,
  })
  return view
}

function caret(view: EditorView) {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  return { line: line.number, column: head - line.from + 1 }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("projectEditorGotoExtension", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    consumeProjectEditorGoto("src/a.ts")
    consumeProjectEditorGoto("src/b.ts")
  })

  it("reveals a live goto addressed to its file", () => {
    const view = mount("src/a.ts")
    window.dispatchEvent(
      new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
        detail: { relPath: "src/a.ts", line: 3, column: 3 },
      })
    )
    expect(caret(view)).toEqual({ line: 3, column: 3 })
    view.destroy()
  })

  it("ignores gotos for other files", () => {
    const view = mount("src/a.ts")
    window.dispatchEvent(
      new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
        detail: { relPath: "src/b.ts", line: 3, column: 1 },
      })
    )
    expect(caret(view)).toEqual({ line: 1, column: 1 })
    view.destroy()
  })

  it("drains a request armed before the editor mounted (cold open)", async () => {
    armProjectEditorGoto({ relPath: "src/a.ts", line: 2, column: 6 })
    const view = mount("src/a.ts")
    await flushMicrotasks()
    expect(caret(view)).toEqual({ line: 2, column: 6 })
    // Consumed — a later mount of the same file does not jump again.
    expect(consumeProjectEditorGoto("src/a.ts")).toBeNull()
    view.destroy()
  })

  it("consumes the armed twin when the live event lands first", async () => {
    const view = mount("src/a.ts")
    await flushMicrotasks()
    armProjectEditorGoto({ relPath: "src/a.ts", line: 4, column: 1 })
    window.dispatchEvent(
      new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
        detail: { relPath: "src/a.ts", line: 4, column: 1 },
      })
    )
    expect(caret(view)).toEqual({ line: 4, column: 1 })
    expect(consumeProjectEditorGoto("src/a.ts")).toBeNull()
    view.destroy()
  })

  it("stops listening once the view is destroyed", () => {
    const view = mount("src/a.ts")
    view.destroy()
    // Would throw on a destroyed view if the listener were still attached.
    expect(() =>
      window.dispatchEvent(
        new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
          detail: { relPath: "src/a.ts", line: 2, column: 1 },
        })
      )
    ).not.toThrow()
  })
})

describe("revealLightEditorLine", () => {
  it("clamps out-of-range lines and columns into the document", () => {
    const parent = document.createElement("div")
    const view = new EditorView({ state: EditorState.create({ doc: DOC }), parent })
    revealLightEditorLine(view, 99, 99)
    expect(caret(view)).toEqual({ line: 4, column: 5 })
    revealLightEditorLine(view, 0, 0)
    expect(caret(view)).toEqual({ line: 1, column: 1 })
    view.destroy()
  })
})
