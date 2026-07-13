/**
 * @jest-environment jsdom
 *
 * Integration coverage for the `@skill:` / `@preset:` namespaced mention picks,
 * driven through the REAL <Composer>. Proves the composer's `onPickPopoverItem`
 * wiring: a skill pick ENABLES the skill (ephemeral chip) and a preset pick
 * APPLIES the preset — both WITHOUT inserting text and without sending a turn.
 * The data-source hooks are mocked so the test exercises the composer's own
 * routing, not Dexie.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({ executeShell: jest.fn(), formatShellResult: jest.fn() }))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
jest.mock("./composer/screenshot-button", () => ({ ScreenshotButton: () => null }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

// New mention sources — fixed lists so the picker is deterministic.
jest.mock("@/hooks/chat/use-mentionable-skills", () => ({
  useMentionableSkills: () => [{ id: "sk_b", name: "Cite sources", description: "Cite all" }],
}))
jest.mock("@/hooks/chat/use-mentionable-presets", () => ({
  useMentionablePresets: () => [
    { id: "p1", name: "Coding", description: "Eng preset", content: "x" },
  ],
}))
jest.mock("@/hooks/chat/use-markdown-chat-agents", () => ({ useMarkdownChatAgents: () => [] }))
jest.mock("@/hooks/chat/use-plugin-slash-commands", () => ({ usePluginSlashCommands: () => [] }))

const applyPresetSpy = jest.fn(async () => true)
jest.mock("@/hooks/chat/use-apply-preset", () => ({ useApplyPreset: () => applyPresetSpy }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@cognia/agent-config-types"

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

const session: ChatSession = {
  id: "ses_np",
  title: "Namespaced",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  workingDir: "/tmp/work",
}

function renderComposer(onSend = jest.fn()) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  return { ta: document.querySelector("textarea") as HTMLTextAreaElement, onSend }
}

async function typeValue(ta: HTMLTextAreaElement, value: string) {
  fireEvent.change(ta, { target: { value } })
  await new Promise((r) => setTimeout(r, 0))
}

const rows = () => screen.queryAllByRole("listitem")

beforeEach(() => {
  useChatStore.getState().clear()
  applyPresetSpy.mockClear()
})

describe("Composer — @skill: pick enables the skill (no text inserted)", () => {
  it("Enter on a skill row toggles it into ephemeral skills and clears the token", async () => {
    const { ta, onSend } = renderComposer()
    await typeValue(ta, "@skill:cite")
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))

    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 30))

    expect(useChatStore.getState().ephemeralSkillIds).toContain("sk_b")
    // The `@skill:…` token is removed — no literal text left behind.
    expect(ta.value).not.toContain("@skill:")
    expect(onSend).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0)
  })
})

describe("Composer — @preset: pick applies the preset (no text inserted)", () => {
  it("Enter on a preset row calls applyPreset with the preset + session and clears the token", async () => {
    const { ta, onSend } = renderComposer()
    await typeValue(ta, "@preset:cod")
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))

    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 30))

    expect(applyPresetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", name: "Coding" }),
      expect.objectContaining({ id: "ses_np" })
    )
    expect(ta.value).not.toContain("@preset:")
    expect(onSend).not.toHaveBeenCalled()
  })
})
