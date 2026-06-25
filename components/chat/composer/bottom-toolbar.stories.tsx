import type { Meta, StoryObj } from "@storybook/nextjs"

import { BottomToolbar } from "./bottom-toolbar"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import type { AppSettings, ChatSession } from "@/lib/claude/types"

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

const meta = {
  title: "Chat/Composer/BottomToolbar",
  component: BottomToolbar,
  parameters: { layout: "padded" },
  beforeEach: seedStores,
  decorators: [
    (Story) => (
      <PromptInputProvider initialInput="Summarize the latest standup notes.">
        <div className="w-full max-w-3xl rounded-md border p-2">
          <Story />
        </div>
      </PromptInputProvider>
    ),
  ],
} satisfies Meta<typeof BottomToolbar>

export default meta
type Story = StoryObj<typeof meta>

// Active session, idle status → the full inline control row (Model / Effort /
// Permission / Sandbox + Enhance / Web search / Skills + the More menu).
export const Default: Story = {
  args: { session },
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
