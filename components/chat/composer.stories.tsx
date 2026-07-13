import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import { fn } from "storybook/test"

import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@cognia/agent-config-types"

// The full chat composer: textarea + toolbar (model / permission / effort /
// attachments / skills / voice) + the slash-command & @mention popovers. It is
// fully props-driven and renders against a mock data adapter + seeded chat
// store, exactly as it does inside ChatPane.
const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withChrome = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="mx-auto w-full max-w-3xl p-4">
      <Story />
    </div>
  </DataAdapterProvider>
)

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "demo-session",
    title: "Demo",
    characterId: "claude",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    workingDir: "/repo",
    ...over,
  }) as ChatSession

const meta = {
  title: "Chat/Composer",
  component: Composer,
  parameters: { layout: "fullscreen" },
  decorators: [withChrome],
  args: {
    session: session(),
    onStartNewSession: fn(),
    onOpenSettings: fn(),
    onSend: fn(),
    onStop: fn(),
  },
  beforeEach: () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
  },
} satisfies Meta<typeof Composer>

export default meta
type Story = StoryObj<typeof meta>

/** Idle, empty composer with the full toolbar. */
export const Default: Story = {}

/** A custom placeholder hint. */
export const CustomPlaceholder: Story = {
  args: { placeholder: "Ask the team anything…" },
}

/** Disabled (e.g. before an API key is configured). */
export const Disabled: Story = {
  args: { disabled: true },
}
