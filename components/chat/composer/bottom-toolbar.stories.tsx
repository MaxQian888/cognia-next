import type { Meta, StoryObj } from "@storybook/nextjs"

import { BottomToolbar } from "./bottom-toolbar"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import type { AppSettings, ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

// BottomToolbar is the aggregate composer toolbar. The generic variant pulls
// from several stores and the PromptInput controller (the Enhance button reads
// the live draft), so it's wrapped in a PromptInputProvider and the settings /
// chat stores are seeded. `useSdkContextUsage` is gated on `isTauri()` (false
// here), so the context gauge falls back to its message-derived estimate with
// no IPC. The workflow variant is covered by WorkflowBottomToolbar's stories.
const seedStores = async () => {
  useSettingsStore.setState({
    settings: {
      defaultModel: "claude-sonnet-4-5",
      defaultProvider: "anthropic",
      providerSettings: {},
      customProviders: [],
      composerAssistance: { enhance: { enabled: true } },
    } as unknown as AppSettings,
  })
  // Reset the per-send composer flags so each story starts from a clean toolbar.
  useChatStore.setState({
    status: "idle",
    webSearchOnForNextSend: false,
    ephemeralSkillIds: [],
  })
}

const session: ChatSession = {
  id: "sess-toolbar-1",
  title: "Wire the composer toolbar",
  model: "claude-sonnet-4-5",
  providerOverride: "anthropic",
} as ChatSession

const preset = (id: string, name: string): SystemPromptPreset =>
  ({ id, name, content: `You are ${name}.`, createdAt: 0, updatedAt: 0 }) as SystemPromptPreset

/**
 * The preset chip reads through the `DataAdapter` context that `app/layout.tsx`
 * mounts, so a story without one crashed the whole toolbar
 * (`useDataAdapter() called outside of <DataAdapterProvider>`). A stub adapter
 * also lets a story choose whether presets exist, which is what decides between
 * the chip's glyph and labelled states.
 */
function stubAdapter(presets: SystemPromptPreset[]): DataAdapter {
  return {
    useCharacters: () => [],
    useCharacter: () => undefined,
    useSkillsByIds: () => [],
    usePresets: () => presets,
    clearMessages: async () => {},
    updateSession: async () => {},
    recordPresetUsage: async () => {},
    trustWorkspace: async () => {},
  }
}

const meta = {
  title: "Chat/Composer/BottomToolbar",
  component: BottomToolbar,
  parameters: { layout: "padded" },
  beforeEach: seedStores,
  decorators: [
    (Story) => (
      <DataAdapterProvider adapter={stubAdapter([])}>
        <PromptInputProvider initialInput="Summarize the latest standup notes.">
          {/* 52rem cap minus the composer's own padding — the width the real
              chat composer measures, so the packing here is the shipped one. */}
          <div className="w-full max-w-[49.5rem] rounded-md border p-2">
            <Story />
          </div>
        </PromptInputProvider>
      </DataAdapterProvider>
    ),
  ],
} satisfies Meta<typeof BottomToolbar>

export default meta
type Story = StoryObj<typeof meta>

// Active session, idle status → the wide row: model / thinking / permission,
// one hairline, then session shape (mode, runtime, preset) and the status
// cluster. Controls sitting on their shipped value render as glyphs.
export const Default: Story = {
  args: { session },
}

// Everything that can occupy the row at once — a model deep enough to show the
// thinking chip, presets configured, and no credential. This is the packing
// that used to overflow: the chips carried full labels, could not shrink, and
// printed over each other.
export const Crowded: Story = {
  args: { session: { ...session, model: "claude-sonnet-5" } as ChatSession },
  beforeEach: async () => {
    await seedStores()
    useSettingsStore.setState({
      settings: {
        ...(useSettingsStore.getState().settings as AppSettings),
        defaultModel: "claude-sonnet-5",
      },
    })
  },
  decorators: [
    (Story) => (
      <DataAdapterProvider
        adapter={stubAdapter([preset("p1", "Staff engineer"), preset("p2", "Copy editor")])}
      >
        <Story />
      </DataAdapterProvider>
    ),
  ],
}

// Streaming in flight → every configuration control is disabled so a mid-turn
// change can't race the send.
export const Streaming: Story = {
  args: { session },
  beforeEach: async () => {
    await seedStores()
    useChatStore.setState({ status: "streaming" })
  },
}
