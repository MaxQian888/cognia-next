/**
 * @jest-environment jsdom
 */

import { renderHook, fireEvent } from "@testing-library/react"
import { useSkillShortcuts } from "./use-skill-shortcuts"
import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"
import { useSkillsStore } from "@/stores/skills"
import { __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import { __resetContextKeysForTesting } from "@/lib/plugin/context-keys/context-key-store"
import type { Skill } from "@cognia/agent-config-types"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut: jest.fn() }),
}))

const skills: Skill[] = [
  { id: "a", name: "Alpha", content: "", createdAt: 0, updatedAt: 0 } as Skill,
  { id: "b", name: "Bravo", content: "", createdAt: 0, updatedAt: 0 } as Skill,
]

// Mount the dispatcher + the feature hook together (no JSX ⇒ .test.ts stays valid).
function mount() {
  return renderHook(() => {
    useAppShortcutDispatcher()
    useSkillShortcuts(skills)
  })
}

function resetStore() {
  useSkillsStore.setState({
    selection: new Set<string>(),
    detailSkillId: null,
    editorTarget: null,
    deleteTarget: null,
  })
}

beforeEach(() => {
  __resetAppRuntimeForTesting()
  __resetAppKeybindingStoreForTesting()
  __resetContextKeysForTesting()
  localStorage.clear()
  resetStore()
})

describe("useSkillShortcuts", () => {
  it("Cmd/Ctrl+A selects all filtered skills", () => {
    mount()
    fireEvent.keyDown(window, { key: "a", ctrlKey: true })
    expect(useSkillsStore.getState().selection).toEqual(new Set(["a", "b"]))
  })

  it("N opens the create editor", () => {
    mount()
    fireEvent.keyDown(window, { key: "n" })
    expect(useSkillsStore.getState().editorTarget).toEqual({ mode: "create" })
  })

  it("Escape clears the selection first, then closes the detail", () => {
    useSkillsStore.setState({ selection: new Set(["a"]), detailSkillId: "a" })
    mount()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(useSkillsStore.getState().selection.size).toBe(0)
    // Detail still open until a second Escape.
    expect(useSkillsStore.getState().detailSkillId).toBe("a")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(useSkillsStore.getState().detailSkillId).toBeNull()
  })

  it("Delete opens the confirm only when exactly one skill is selected", () => {
    useSkillsStore.setState({ selection: new Set(["b"]) })
    mount()
    fireEvent.keyDown(window, { key: "Delete" })
    expect(useSkillsStore.getState().deleteTarget).toEqual({ skillId: "b", name: "Bravo" })
  })

  it("Backspace also triggers delete for a single selection", () => {
    useSkillsStore.setState({ selection: new Set(["a"]) })
    mount()
    fireEvent.keyDown(window, { key: "Backspace" })
    expect(useSkillsStore.getState().deleteTarget).toEqual({ skillId: "a", name: "Alpha" })
  })

  it("Delete is a no-op with a multi-selection", () => {
    useSkillsStore.setState({ selection: new Set(["a", "b"]) })
    mount()
    fireEvent.keyDown(window, { key: "Delete" })
    expect(useSkillsStore.getState().deleteTarget).toBeNull()
  })

  it("focuses the search box on '/'", () => {
    const input = document.createElement("input")
    input.setAttribute("data-skill-search", "")
    document.body.appendChild(input)
    mount()
    fireEvent.keyDown(window, { key: "/" })
    expect(document.activeElement).toBe(input)
    document.body.removeChild(input)
  })

  it("ignores letter keys while typing in an input", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    mount()
    fireEvent.keyDown(input, { key: "n" })
    expect(useSkillsStore.getState().editorTarget).toBeNull()
    document.body.removeChild(input)
  })
})
