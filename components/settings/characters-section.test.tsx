/**
 * @jest-environment jsdom
 *
 * Focused coverage for the ADR-0030 v2 fields added to `CharacterEditor`
 * (persona / voice / avatar image / platform availability). The pure
 * state→output projection is tested in
 * `lib/plugin/character-pack/editor-projection.test.ts`; this exercises the
 * editor wiring — that the form hydrates from `initial` and `onSave` receives
 * the projected v2 shapes.
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/character/twin-binding-section", () => ({
  TwinBindingSection: () => null,
}))

jest.mock("@/components/settings/speech/test-tts-button", () => ({
  TestTtsButton: () => null,
}))

jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => ({
  listNativeAnthropicToolEntries: () => [],
}))

jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(async () => []),
}))

// --- Mounting <CharactersSection> needs the data layer stubbed. -------------
// `mock`-prefixed names are the only out-of-scope refs jest allows inside a
// hoisted factory.
let mockCharacterList: Character[] = []
const mockDeleteCharacter = jest.fn(async (_id: string) => undefined)
const mockDownloadBlob = jest.fn()

jest.mock("dexie-react-hooks", () => ({
  // The three useLiveQuery calls (characters/skills/mcp) read synchronous
  // mock data — invoke the query fn and return its result directly.
  useLiveQuery: (fn: () => unknown) => fn(),
}))

jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => mockCharacterList,
  createCharacter: jest.fn(async () => ({ id: "new" })),
  updateCharacter: jest.fn(async () => undefined),
  deleteCharacter: (id: string) => mockDeleteCharacter(id),
  duplicateCharacter: jest.fn(async () => ({ id: "dup" })),
  applyPackUpdate: jest.fn(async () => undefined),
  applyPackUpdateForPack: jest.fn(async () => undefined),
  dismissPackUpdate: jest.fn(async () => undefined),
}))

jest.mock("@/lib/db/skills", () => ({ listSkills: () => [] }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: () => [] }))
jest.mock("@/hooks/plugins/use-plugin-metadata", () => ({ usePluginMetadata: () => undefined }))
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: (sel: (s: { plugins: Record<string, unknown> }) => unknown) =>
    sel({ plugins: {} }),
}))
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (
    sel: (s: { pendingCreateRequest: undefined; clearPendingCreate: () => void }) => unknown
  ) => sel({ pendingCreateRequest: undefined, clearPendingCreate: () => {} }),
}))
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...a: unknown[]) => mockDownloadBlob(...a),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CharacterEditor, CharactersSection, type EditorState } from "./characters-section"
import type { Character } from "@/lib/claude/types"

// Narrow view of the EditorOutput payload the assertions read.
type SavePayload = {
  persona?: unknown
  voiceProfile?: unknown
  avatarImage?: { webDataUrl?: string }
  availableOnPlatforms?: unknown
}

function baseInitial(overrides: Partial<EditorState> = {}): EditorState {
  return {
    name: "Tutor",
    description: "",
    avatarColor: "oklch(0.7 0 0)",
    avatarEmoji: "🐙",
    systemPrompt: "You are a tutor.",
    model: "",
    permissionMode: undefined,
    allowedTools: [],
    disallowedTools: [],
    mcpServerIds: undefined,
    skillIds: [],
    workingDir: "",
    bareMode: false,
    debugMode: false,
    briefMode: false,
    twinId: undefined,
    twinSettings: undefined,
    enableComputerUse: false,
    computerUseSettings: undefined,
    sandboxEnabled: false,
    sandboxTier: "inherit",
    accountIdOverride: "inherit",
    personaTone: "",
    personaPersonality: "",
    openingMessage: "",
    exemplarPromptsText: "",
    avatarImageDataUrl: "",
    voiceProvider: "none",
    voiceId: "",
    voiceRate: 1,
    voicePitch: 1,
    voiceVolume: 1,
    availablePlatforms: [],
    ...overrides,
  }
}

function renderEditor(initial: EditorState) {
  const onSave = jest.fn(async (_data: SavePayload) => undefined)
  render(
    <CharacterEditor
      initial={initial}
      skillsCatalog={[]}
      mcpCatalog={[]}
      submitLabel="Save"
      onCancel={() => undefined}
      onSave={onSave}
    />
  )
  return { onSave }
}

describe("CharacterEditor — v2 fields", () => {
  it("hydrates persona, voice, avatar image, and platform fields from initial and saves them", async () => {
    const { onSave } = renderEditor(
      baseInitial({
        personaTone: "warm",
        personaPersonality: "Patient teacher",
        openingMessage: "Hi there!",
        exemplarPromptsText: "Explain X\nDraft Y",
        avatarImageDataUrl: "data:image/png;base64,AAAA",
        voiceProvider: "openai",
        voiceId: "alloy",
        availablePlatforms: ["tauri"],
      })
    )

    // Persona inputs hydrate.
    expect(screen.getByDisplayValue("warm")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Patient teacher")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Hi there!")).toBeInTheDocument()
    // Avatar image renders.
    expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA")

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0]
    expect(payload.persona).toEqual({
      tone: "warm",
      personality: "Patient teacher",
      openingMessage: "Hi there!",
      exemplarPrompts: ["Explain X", "Draft Y"],
    })
    expect(payload.voiceProfile).toEqual({
      provider: "openai",
      voiceId: "alloy",
      rate: 1,
      pitch: 1,
      volume: 1,
    })
    expect(payload.avatarImage).toEqual({ webDataUrl: "data:image/png;base64,AAAA" })
    expect(payload.availableOnPlatforms).toEqual(["tauri"])
  })

  it("omits the v2 fields when blank (no persona / voice / image / platform restriction)", async () => {
    const { onSave } = renderEditor(baseInitial())
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0]
    expect(payload.persona).toBeUndefined()
    expect(payload.voiceProfile).toBeUndefined()
    expect(payload.avatarImage).toBeUndefined()
    expect(payload.availableOnPlatforms).toBeUndefined()
  })

  it("toggles a platform restriction via the badge", async () => {
    const { onSave } = renderEditor(baseInitial())
    fireEvent.click(screen.getByText("platforms.tauri"))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].availableOnPlatforms).toEqual(["tauri"])
  })

  it("clears the avatar image via the remove button", async () => {
    const { onSave } = renderEditor(
      baseInitial({ avatarImageDataUrl: "data:image/png;base64,AAAA" })
    )
    expect(document.querySelector("img")).not.toBeNull()
    fireEvent.click(screen.getByText("avatarImage.clear"))
    expect(document.querySelector("img")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].avatarImage).toBeUndefined()
  })

  it("reads an uploaded image file into a data URL", async () => {
    const { onSave } = renderEditor(baseInitial())
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["binary"], "avatar.png", { type: "image/png" })
    fireEvent.change(fileInput, { target: { files: [file] } })
    // FileReader.readAsDataURL is async — wait for the avatar img to appear.
    await waitFor(() =>
      expect(document.querySelector("img")?.getAttribute("src")).toMatch(/^data:/)
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].avatarImage?.webDataUrl).toMatch(/^data:/)
  })
})

describe("CharactersSection — list, search & bulk (C2/C3)", () => {
  beforeEach(() => {
    mockCharacterList = [
      {
        id: "char_a",
        name: "Coder",
        systemPrompt: "x",
        avatarColor: "#abc",
        isBuiltIn: true,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "char_b",
        name: "Helper",
        description: "writes docs",
        systemPrompt: "x",
        avatarColor: "#abc",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "char_c",
        name: "Researcher",
        systemPrompt: "x",
        avatarColor: "#abc",
        createdAt: 0,
        updatedAt: 0,
      },
    ] as Character[]
    mockDeleteCharacter.mockReset().mockResolvedValue(undefined)
    mockDownloadBlob.mockReset()
  })

  it("renders all characters and filters by search query (name + description)", () => {
    render(<CharactersSection />)
    expect(screen.getByText("Coder")).toBeInTheDocument()
    expect(screen.getByText("Helper")).toBeInTheDocument()
    expect(screen.getByText("Researcher")).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), { target: { value: "doc" } })
    expect(screen.queryByText("Coder")).not.toBeInTheDocument()
    expect(screen.getByText("Helper")).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), { target: { value: "zzz" } })
    expect(screen.getByText("noMatches")).toBeInTheDocument()
  })

  it("bulk-deletes selected characters, tolerating ones that can't be deleted", async () => {
    mockDeleteCharacter.mockImplementation(async (id: string) => {
      if (id === "char_a") throw new Error("built-in")
    })
    render(<CharactersSection />)
    fireEvent.click(screen.getByRole("button", { name: "bulk.select" }))
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes).toHaveLength(3)
    checkboxes.forEach((cb) => fireEvent.click(cb))
    fireEvent.click(screen.getByRole("button", { name: /bulk\.deleteSelected/ }))
    await waitFor(() => expect(mockDeleteCharacter).toHaveBeenCalledTimes(3))
    expect(mockDeleteCharacter).toHaveBeenCalledWith("char_a")
    expect(mockDeleteCharacter).toHaveBeenCalledWith("char_b")
    // Exits selection mode without crashing despite the rejected delete.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "bulk.select" })).toBeInTheDocument()
    )
  })

  it("bulk-exports selected characters as a .cognia-pack.json download", () => {
    render(<CharactersSection />)
    fireEvent.click(screen.getByRole("button", { name: "bulk.select" }))
    fireEvent.click(screen.getAllByRole("checkbox")[1]) // Helper
    fireEvent.click(screen.getByRole("button", { name: /bulk\.exportSelected/ }))
    expect(mockDownloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = mockDownloadBlob.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(filename).toMatch(/\.cognia-pack\.json$/)
  })

  it("disables the bulk actions until at least one character is selected", () => {
    render(<CharactersSection />)
    fireEvent.click(screen.getByRole("button", { name: "bulk.select" }))
    expect(screen.getByRole("button", { name: /bulk\.deleteSelected/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /bulk\.exportSelected/ })).toBeDisabled()
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    expect(screen.getByRole("button", { name: /bulk\.deleteSelected/ })).toBeEnabled()
  })
})
