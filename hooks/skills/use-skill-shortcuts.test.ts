/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { fireEvent } from "@testing-library/react"
import { useSkillShortcuts } from "./use-skill-shortcuts"
import { useSkillsStore } from "@/stores/skills"
import type { Skill } from "@/lib/claude/types"

const skills: Skill[] = [
  { id: "a", name: "Alpha", content: "", createdAt: 0, updatedAt: 0 } as Skill,
  { id: "b", name: "Bravo", content: "", createdAt: 0, updatedAt: 0 } as Skill,
]

function resetStore() {
  useSkillsStore.setState({
    selection: new Set<string>(),
    detailSkillId: null,
    editorTarget: null,
    deleteTarget: null,
  })
}

beforeEach(resetStore)

describe("useSkillShortcuts", () => {
  it("Cmd/Ctrl+A selects all filtered skills", () => {
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(window, { key: "a", ctrlKey: true })
    expect(useSkillsStore.getState().selection).toEqual(new Set(["a", "b"]))
  })

  it("N opens the create editor", () => {
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(window, { key: "n" })
    expect(useSkillsStore.getState().editorTarget).toEqual({ mode: "create" })
  })

  it("Escape clears the selection first, then closes the detail", () => {
    useSkillsStore.setState({ selection: new Set(["a"]), detailSkillId: "a" })
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(window, { key: "Escape" })
    expect(useSkillsStore.getState().selection.size).toBe(0)
    // Detail still open until a second Escape.
    expect(useSkillsStore.getState().detailSkillId).toBe("a")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(useSkillsStore.getState().detailSkillId).toBeNull()
  })

  it("Delete opens the confirm only when exactly one skill is selected", () => {
    useSkillsStore.setState({ selection: new Set(["b"]) })
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(window, { key: "Delete" })
    expect(useSkillsStore.getState().deleteTarget).toEqual({ skillId: "b", name: "Bravo" })
  })

  it("Delete is a no-op with a multi-selection", () => {
    useSkillsStore.setState({ selection: new Set(["a", "b"]) })
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(window, { key: "Delete" })
    expect(useSkillsStore.getState().deleteTarget).toBeNull()
  })

  it("focuses the search box on '/'", () => {
    const input = document.createElement("input")
    input.setAttribute("data-skill-search", "")
    document.body.appendChild(input)
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(window, { key: "/" })
    expect(document.activeElement).toBe(input)
    document.body.removeChild(input)
  })

  it("ignores letter keys while typing in an input", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    renderHook(() => useSkillShortcuts(skills))
    fireEvent.keyDown(input, { key: "n" })
    expect(useSkillsStore.getState().editorTarget).toBeNull()
    document.body.removeChild(input)
  })
})
