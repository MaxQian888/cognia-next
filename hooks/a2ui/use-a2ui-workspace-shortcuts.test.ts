/**
 * Tests for useA2UIWorkspaceShortcuts — the workspace editor's keyboard map.
 *
 * Verifies: keydown listener registers + cleans up; shortcut routing; bypass
 * when typing into form fields; the `enabled: false` short-circuit.
 */

import { renderHook } from "@testing-library/react"
import { useA2UIWorkspaceShortcuts } from "./use-a2ui-workspace-shortcuts"

const undo = jest.fn()
const redo = jest.fn()

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ undo, redo }),
}))

function dispatch(opts: Partial<KeyboardEventInit> & { key: string; on?: HTMLElement }) {
  const target = opts.on ?? document.body
  target.focus?.()
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: opts.ctrlKey,
    metaKey: opts.metaKey,
    shiftKey: opts.shiftKey,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(ev)
  return ev
}

describe("useA2UIWorkspaceShortcuts", () => {
  beforeEach(() => {
    undo.mockReset()
    redo.mockReset()
    document.body.innerHTML = ""
  })

  it("registers and removes a global keydown listener tied to enabled", () => {
    const add = jest.spyOn(document, "addEventListener")
    const remove = jest.spyOn(document, "removeEventListener")
    const { unmount } = renderHook(() => useA2UIWorkspaceShortcuts({ surfaceId: "sx" }))
    expect(add).toHaveBeenCalledWith("keydown", expect.any(Function))
    unmount()
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function))
    add.mockRestore()
    remove.mockRestore()
  })

  it("does NOT register a listener when enabled is false", () => {
    const add = jest.spyOn(document, "addEventListener")
    renderHook(() => useA2UIWorkspaceShortcuts({ surfaceId: "sx", enabled: false }))
    expect(add).not.toHaveBeenCalledWith("keydown", expect.any(Function))
    add.mockRestore()
  })

  it("routes Ctrl+Z to undo and Ctrl+Y to redo", () => {
    renderHook(() => useA2UIWorkspaceShortcuts({ surfaceId: "sx" }))
    dispatch({ key: "z", ctrlKey: true })
    expect(undo).toHaveBeenCalledWith("sx")
    dispatch({ key: "y", ctrlKey: true })
    expect(redo).toHaveBeenCalledWith("sx")
  })

  it("routes Ctrl+Shift+Z to redo", () => {
    renderHook(() => useA2UIWorkspaceShortcuts({ surfaceId: "sx" }))
    dispatch({ key: "z", ctrlKey: true, shiftKey: true })
    expect(redo).toHaveBeenCalledWith("sx")
  })

  it("invokes the onSave / onDelete / onDuplicate / onDeselect / onToggleMode handlers", () => {
    const onSave = jest.fn()
    const onDeleteComponent = jest.fn()
    const onDuplicateComponent = jest.fn()
    const onDeselect = jest.fn()
    const onToggleMode = jest.fn()
    renderHook(() =>
      useA2UIWorkspaceShortcuts({
        surfaceId: "sx",
        onSave,
        onDeleteComponent,
        onDuplicateComponent,
        onDeselect,
        onToggleMode,
      })
    )

    dispatch({ key: "s", ctrlKey: true })
    expect(onSave).toHaveBeenCalled()

    dispatch({ key: "Delete" })
    expect(onDeleteComponent).toHaveBeenCalled()

    dispatch({ key: "d", ctrlKey: true })
    expect(onDuplicateComponent).toHaveBeenCalled()

    dispatch({ key: "Escape" })
    expect(onDeselect).toHaveBeenCalled()

    dispatch({ key: "e", ctrlKey: true })
    expect(onToggleMode).toHaveBeenCalled()
  })

  it("bypasses shortcuts when the user is typing in an input/textarea/select/contentEditable", () => {
    const onSave = jest.fn()
    renderHook(() => useA2UIWorkspaceShortcuts({ surfaceId: "sx", onSave }))

    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    dispatch({ key: "s", ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()

    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)
    textarea.focus()
    dispatch({ key: "s", ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("ignores unrelated keys", () => {
    renderHook(() => useA2UIWorkspaceShortcuts({ surfaceId: "sx" }))
    dispatch({ key: "a" })
    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })
})
