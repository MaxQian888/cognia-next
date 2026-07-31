import type { Meta, StoryObj } from "@storybook/nextjs"

import { TerminalSection } from "./terminal-section"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"

// `TerminalSection` is the settings page section for the integrated terminal
// dock — a heading + the `TerminalCard`. Reset the settings + project stores so
// the embedded card and per-project override start from a clean slate.
const meta = {
  title: "Settings/Terminal/TerminalSection",
  component: TerminalSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStores(useSettingsStore, useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
