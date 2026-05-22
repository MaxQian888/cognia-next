// ADR-0030 — CharacterMissingBanner renders only for synthetic overlay
// ids whose pack is no longer registered; silent for plain Dexie ids.

import { render, screen, fireEvent } from "@testing-library/react"
import type { ReactNode } from "react"
import { CharacterMissingBanner } from "./character-missing-banner"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { Character } from "@/lib/claude/types"

// Same plugin-store stub as character-picker.test.tsx — keeps the suite
// self-contained without booting the full plugin manager.
let pluginsState: Record<string, { id: string; manifest: { name?: string } }> = {}
jest.mock("@/stores/plugin/plugin-store", () => ({
  usePluginStore: <T,>(selector: (s: { plugins: typeof pluginsState }) => T) =>
    selector({ plugins: pluginsState }),
}))

function makeAdapter(resolved: Character | undefined): DataAdapter {
  return {
    useCharacters: () => [],
    useCharacter: () => resolved,
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
  Wrapper.displayName = "CharacterMissingBannerTestWrapper"
  return Wrapper
}

beforeEach(() => {
  pluginsState = {}
})

describe("CharacterMissingBanner", () => {
  it("renders nothing when characterId is empty", () => {
    const Wrapper = withAdapter(makeAdapter(undefined))
    const { container } = render(
      <Wrapper>
        <CharacterMissingBanner characterId={undefined} />
      </Wrapper>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the character resolves", () => {
    const resolved: Character = {
      id: "char_x",
      name: "X",
      avatarColor: "#000",
      systemPrompt: "x",
      createdAt: 0,
      updatedAt: 0,
    }
    const Wrapper = withAdapter(makeAdapter(resolved))
    const { container } = render(
      <Wrapper>
        <CharacterMissingBanner characterId="char_x" />
      </Wrapper>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("stays silent for plain Dexie ids that don't resolve (no recovery action)", () => {
    const Wrapper = withAdapter(makeAdapter(undefined))
    const { container } = render(
      <Wrapper>
        <CharacterMissingBanner characterId="char_missing_user_row" />
      </Wrapper>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a destructive Alert for a synthetic overlay id that no longer resolves", () => {
    pluginsState = { "plug-a": { id: "plug-a", manifest: { name: "Plug A" } } }
    const Wrapper = withAdapter(makeAdapter(undefined))
    render(
      <Wrapper>
        <CharacterMissingBanner characterId="cognia-pack:plug-a:workplace:alice" />
      </Wrapper>
    )
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("invokes onPickAnother when the action button is clicked", () => {
    const onPickAnother = jest.fn()
    const Wrapper = withAdapter(makeAdapter(undefined))
    render(
      <Wrapper>
        <CharacterMissingBanner
          characterId="cognia-pack:plug-a:workplace:alice"
          onPickAnother={onPickAnother}
        />
      </Wrapper>
    )
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBeGreaterThan(0)
    fireEvent.click(buttons[0])
    expect(onPickAnother).toHaveBeenCalledTimes(1)
  })

  it("renders the local-file source label when the plugin segment is local:imported", () => {
    const Wrapper = withAdapter(makeAdapter(undefined))
    render(
      <Wrapper>
        <CharacterMissingBanner characterId="cognia-pack:local:imported:study:carol" />
      </Wrapper>
    )
    expect(screen.getByRole("status")).toBeInTheDocument()
  })
})
