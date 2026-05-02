// Coverage for character-picker after the data-hooks refactor — verifies the
// component reads characters via DataAdapter (no direct Dexie call) and that
// `onPick` / `onOpenChange` fire correctly.

import { render, screen, fireEvent } from "@testing-library/react"
import type { ReactNode } from "react"
import { CharacterPicker } from "./character-picker"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { Character } from "@/lib/claude/types"

function makeAdapter(characters: Character[]): DataAdapter {
  return {
    useCharacters: () => characters,
    useCharacter: () => undefined,
    useSkillsByIds: () => [],
    usePresets: () => [],
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>{children}</DataAdapterProvider>
  )
  Wrapper.displayName = "CharacterPickerTestWrapper"
  return Wrapper
}

const mkChar = (name: string, id = name.toLowerCase()): Character => ({
  id,
  name,
  avatarColor: "#3b82f6",
  systemPrompt: "...",
  createdAt: 0,
  updatedAt: 0,
})

describe("CharacterPicker", () => {
  it("renders the empty state when no characters exist", () => {
    const Wrapper = withAdapter(makeAdapter([]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </Wrapper>
    )
    // Empty-message comes from translations; assert the list is empty.
    expect(screen.queryByRole("option")).toBeNull()
  })

  it("renders the supplied character list", () => {
    const Wrapper = withAdapter(makeAdapter([mkChar("Alice"), mkChar("Bob")]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </Wrapper>
    )
    expect(screen.getByText("Alice")).toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
  })

  it("calls onPick + closes the dialog when an item is selected", () => {
    const onPick = jest.fn()
    const onOpenChange = jest.fn()
    const c = mkChar("Echo")
    const Wrapper = withAdapter(makeAdapter([c]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={onOpenChange} onPick={onPick} />
      </Wrapper>
    )
    fireEvent.click(screen.getByText("Echo"))
    expect(onPick).toHaveBeenCalledWith(c)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("treats undefined adapter return as an empty list (no crash)", () => {
    const adapter: DataAdapter = {
      ...makeAdapter([]),
      useCharacters: () => undefined,
    }
    render(
      <DataAdapterProvider adapter={adapter}>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </DataAdapterProvider>
    )
    expect(screen.queryByRole("option")).toBeNull()
  })
})
