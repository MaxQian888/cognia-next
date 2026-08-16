import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { ComposerPresetChip } from "./preset-chip"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { ChatSession, Character, Skill, SystemPromptPreset } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The sheet owns the conflict dialog; here it only needs to report whether the
// chip asked for it.
jest.mock("@/components/chat/session-settings-sheet", () => ({
  SessionSettingsSheet: ({ open }: { open: boolean }) => (
    <div data-testid="session-settings-sheet" data-open={open ? "true" : "false"} />
  ),
}))

const STABLE_EMPTY_CHARACTERS: Character[] = []
const STABLE_EMPTY_SKILLS: Skill[] = []
const STABLE_EMPTY_PRESETS: SystemPromptPreset[] = []

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => STABLE_EMPTY_CHARACTERS,
    useCharacter: () => undefined,
    useSkillsByIds: () => STABLE_EMPTY_SKILLS,
    usePresets: () => STABLE_EMPTY_PRESETS,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>{children}</DataAdapterProvider>
  )
  Wrapper.displayName = "PresetChipTestWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_1",
  title: "Untitled",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

const presets: SystemPromptPreset[] = [
  {
    id: "p1",
    name: "pill-preset-one",
    content: "You are terse.",
    model: "claude-sonnet-5",
    isBuiltIn: false,
    isDefault: false,
    isFavorite: false,
    sortOrder: 0,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
  },
]

describe("ComposerPresetChip", () => {
  it("self-hides when there are no presets", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ComposerPresetChip session={mkSession()} />
      </Wrapper>
    )
    expect(screen.queryByTestId("chat-header-preset-pill")).toBeNull()
  })

  it("wears the host's chip styling and applies a conflict-free preset in place", async () => {
    const updateSession = jest.fn(async () => undefined)
    const recordPresetUsage = jest.fn(async () => undefined)
    const Wrapper = withAdapter(
      makeAdapter({ usePresets: () => presets, updateSession, recordPresetUsage })
    )
    render(
      <Wrapper>
        <ComposerPresetChip
          session={mkSession({ systemPrompt: undefined, model: undefined })}
          className="toolbar-chip"
        />
      </Wrapper>
    )
    const pill = screen.getByTestId("chat-header-preset-pill")
    expect(pill).toHaveClass("toolbar-chip")
    fireEvent.click(pill)
    fireEvent.click(await screen.findByText("pill-preset-one"))
    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    const [id, patch] = updateSession.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(id).toBe("ses_1")
    expect(patch).toMatchObject({
      activePresetId: "p1",
      systemPrompt: "You are terse.",
      model: "claude-sonnet-5",
    })
    expect(recordPresetUsage).toHaveBeenCalledWith("p1")
    expect(screen.getByTestId("session-settings-sheet")).toHaveAttribute("data-open", "false")
  })

  it("routes a conflicting pick to the settings sheet instead of overwriting", async () => {
    const updateSession = jest.fn(async () => undefined)
    const Wrapper = withAdapter(makeAdapter({ usePresets: () => presets, updateSession }))
    render(
      <Wrapper>
        <ComposerPresetChip
          session={mkSession({ systemPrompt: "Existing prompt", model: "other" })}
        />
      </Wrapper>
    )
    fireEvent.click(screen.getByTestId("chat-header-preset-pill"))
    fireEvent.click(await screen.findByText("pill-preset-one"))
    await waitFor(() =>
      expect(screen.getByTestId("session-settings-sheet")).toHaveAttribute("data-open", "true")
    )
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("is inert while a turn streams", () => {
    const Wrapper = withAdapter(makeAdapter({ usePresets: () => presets }))
    render(
      <Wrapper>
        <ComposerPresetChip session={mkSession()} disabled />
      </Wrapper>
    )
    expect(screen.getByTestId("chat-header-preset-pill")).toBeDisabled()
  })
})
