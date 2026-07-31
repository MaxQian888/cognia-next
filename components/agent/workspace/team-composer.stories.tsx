import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import { fn } from "storybook/test"

import { TeamComposer } from "./team-composer"
import { buildMentionableTargets } from "@/lib/agent-team/runtime-targets"
import { buildTeammate } from "@/lib/storybook/fixtures/agent-team"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"

const mentionables = buildMentionableTargets([
  buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate", config: { runtime: "codex" } }),
])

// `TeamComposer` renders the shared `<Composer>`, whose `useUpdateSession()`
// reads `useDataAdapter()` and throws without a provider (real one lives in
// app/layout.tsx). Supply an all-empty mock adapter — the composer needs the
// provider mounted, not any real data — mirroring the other chat stories.
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

const withDataAdapter = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <Story />
  </DataAdapterProvider>
)

const meta = {
  title: "Agent/Workspace/TeamComposer",
  component: TeamComposer,
  parameters: { layout: "fullscreen" },
  decorators: [withDataAdapter],
  args: {
    mentionables,
    onSend: fn(),
    onStop: fn(),
  },
} satisfies Meta<typeof TeamComposer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Streaming banner with a stop button above the textarea.
export const Streaming: Story = {
  args: { isStreaming: true },
}

export const Disabled: Story = {
  args: { disabled: true },
}
