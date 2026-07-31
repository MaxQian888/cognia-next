/**
 * @jest-environment jsdom
 *
 * Tests for useA2UIWorkspaceShortcuts — end-to-end through the shared dispatcher.
 * Verifies: registration lifecycle; shortcut routing; the editable-field bypass;
 * and the `enabled: false` short-circuit (no runtime slot at all).
 */

import { renderHook } from "@testing-library/react"
import { useA2UIWorkspaceShortcuts } from "./use-a2ui-workspace-shortcuts"
import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import { __resetContextKeysForTesting } from "@/lib/plugin/context-keys/context-key-store"

const undo = jest.fn()
const redo = jest.fn()

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ undo, redo }),
}))
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut: jest.fn() }),
}))

type Actions = Parameters<typeof useA2UIWorkspaceShortcuts>[0]

function mount(actions: Actions) {
  return renderHook(() => {
    useAppShortcutDispatcher()
    useA2UIWorkspaceShortcuts(actions)
  })
}

function dispatch(opts: Partial<KeyboardEventInit> & { key: string; on?: HTMLElement }) {
  const target = opts.on ?? document.body
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: opts.ctrlKey,
    metaKey: opts.metaKey,
    shiftKey: opts.shiftKey,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(ev)
  return ev
}

describe("useA2UIWorkspaceShortcuts", () => {
  beforeEach(() => {
    undo.mockReset()
    redo.mockReset()
    document.body.innerHTML = ""
    __resetAppRuntimeForTesting()
    __resetAppKeybindingStoreForTesting()
    __resetContextKeysForTesting()
    localStorage.clear()
  })

  it("registers its actions while mounted and removes them on unmount", () => {
    const { unmount } = mount({ surfaceId: "sx" })
    expect(getAppRegistration("a2ui.undo")).toBeDefined()
    expect(getAppRegistration("a2ui.save")).toBeDefined()
    unmount()
    expect(getAppRegistration("a2ui.undo")).toBeUndefined()
    expect(getAppRegistration("a2ui.save")).toBeUndefined()
  })

  it("registers nothing when enabled is false", () => {
    mount({ surfaceId: "sx", enabled: false })
    expect(getAppRegistration("a2ui.undo")).toBeUndefined()
    expect(getAppRegistration("a2ui.save")).toBeUndefined()
  })

  it("routes Ctrl+Z to undo and Ctrl+Y to redo", () => {
    mount({ surfaceId: "sx" })
    dispatch({ key: "z", ctrlKey: true })
    expect(undo).toHaveBeenCalledWith("sx")
    dispatch({ key: "y", ctrlKey: true })
    expect(redo).toHaveBeenCalledWith("sx")
  })

  it("routes Ctrl+Shift+Z to redo", () => {
    mount({ surfaceId: "sx" })
    dispatch({ key: "z", ctrlKey: true, shiftKey: true })
    expect(redo).toHaveBeenCalledWith("sx")
    expect(undo).not.toHaveBeenCalled()
  })

  it("invokes the onSave / onDelete / onDuplicate / onDeselect / onToggleMode handlers", () => {
    const onSave = jest.fn()
    const onDeleteComponent = jest.fn()
    const onDuplicateComponent = jest.fn()
    const onDeselect = jest.fn()
    const onToggleMode = jest.fn()
    mount({
      surfaceId: "sx",
      onSave,
      onDeleteComponent,
      onDuplicateComponent,
      onDeselect,
      onToggleMode,
    })

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

  it("bypasses shortcuts when the event originates from an editable control", () => {
    const onSave = jest.fn()
    mount({ surfaceId: "sx", onSave })

    const input = document.createElement("input")
    document.body.appendChild(input)
    dispatch({ key: "s", ctrlKey: true, on: input })
    expect(onSave).not.toHaveBeenCalled()

    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)
    dispatch({ key: "s", ctrlKey: true, on: textarea })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("ignores unrelated keys", () => {
    mount({ surfaceId: "sx" })
    dispatch({ key: "a" })
    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })
})
