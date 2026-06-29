import type { Meta, StoryObj } from "@storybook/nextjs"

import { PromptPresetsSection } from "./prompt-presets-section"

// `PromptPresetsSection` is the system-prompt preset manager. It reads presets,
// skills, and MCP servers from Dexie via `useLiveQuery`. With an empty Storybook
// IndexedDB it renders the empty preset library (search + create affordances).
// The `mobile` prop switches to a single-column layout.
const meta = {
  title: "Settings/PromptPresetsSection",
  component: PromptPresetsSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PromptPresetsSection>

export default meta
type Story = StoryObj<typeof meta>

// Desktop two-column layout (empty library).
export const Default: Story = {}

// Mobile single-column layout.
export const Mobile: Story = {
  args: { mobile: true },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[390px] overflow-auto p-3">
        <Story />
      </div>
    ),
  ],
}
