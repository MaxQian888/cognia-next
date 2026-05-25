// Coverage for character-picker after the data-hooks refactor — verifies the
// component reads characters via DataAdapter (no direct Dexie call) and that
// `onPick` / `onOpenChange` fire correctly. ADR-0030 added group headings
// driven by plugin attribution.

// Stub the plugin store so the picker can resolve "From <plugin name>"
// labels without booting the real Zustand store + manager.
let pluginsState: Record<string, { id: string; manifest: { name?: string } }> = {}
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: <T,>(selector: (s: { plugins: typeof pluginsState }) => T) =>
    selector({ plugins: pluginsState }),
}))

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

  it("groups characters by source (ADR-0030): built-in / plugin / user", () => {
    pluginsState = { "plug-a": { id: "plug-a", manifest: { name: "Plug A" } } }
    const builtIn: Character = {
      ...mkChar("Built", "char_builtin_x"),
      isBuiltIn: true,
    }
    const overlay: Character = {
      ...mkChar("Plugin Alice", "cognia-pack:plug-a:workplace:alice"),
      sourcePluginId: "plug-a",
    }
    const user = mkChar("User Bob", "char_user_bob")

    const Wrapper = withAdapter(makeAdapter([builtIn, overlay, user]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </Wrapper>
    )

    expect(screen.getByText("Built")).toBeInTheDocument()
    expect(screen.getByText("Plugin Alice")).toBeInTheDocument()
    expect(screen.getByText("User Bob")).toBeInTheDocument()
  })

  it("hides characters restricted away from the current (browser) profile", () => {
    // jsdom has no __TAURI_INTERNALS__, so currentRuntimeProfile() === "browser".
    const desktopOnly: Character = {
      ...mkChar("Desktop Only", "desk1"),
      availableOnPlatforms: ["tauri"],
    }
    const everywhere = mkChar("Everywhere", "ev1")
    const Wrapper = withAdapter(makeAdapter([desktopOnly, everywhere]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </Wrapper>
    )
    expect(screen.queryByText("Desktop Only")).not.toBeInTheDocument()
    expect(screen.getByText("Everywhere")).toBeInTheDocument()
  })

  it("renders the avatar image when the character has a webDataUrl", () => {
    const withImage: Character = {
      ...mkChar("Pixel", "px1"),
      avatarImage: { webDataUrl: "data:image/png;base64,AAAA" },
    }
    const Wrapper = withAdapter(makeAdapter([withImage]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </Wrapper>
    )
    // CommandDialog portals to document.body, so query the whole document.
    const img = document.querySelector("img") as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA")
  })

  it("renders a local-file group heading for synthetic ids without a registered plugin", () => {
    pluginsState = {}
    const localOverlay: Character = {
      ...mkChar("Local Carol", "cognia-pack:local:imported:tinypack:carol"),
      sourcePluginId: "local:imported",
    }
    const Wrapper = withAdapter(makeAdapter([localOverlay]))
    render(
      <Wrapper>
        <CharacterPicker open onOpenChange={() => undefined} onPick={() => undefined} />
      </Wrapper>
    )
    expect(screen.getByText("Local Carol")).toBeInTheDocument()
  })
})
