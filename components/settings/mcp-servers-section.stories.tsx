import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpServersSection } from "./mcp-servers-section"

// `McpServersSection` is a thin viewport-height wrapper around the full
// multi-tab `<McpPanel>` (My Servers / Preset Market / Agent Sync / Health &
// Logs). Server rows come from Dexie via `useLiveQuery`; with an empty Storybook
// database the panel renders its tab chrome over the empty "My Servers" state.
const meta = {
  title: "Settings/McpServersSection",
  component: McpServersSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[720px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpServersSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
