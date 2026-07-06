import type { Meta, StoryObj } from "@storybook/nextjs"

import { CustomizeTab } from "./customize-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// The `/pet` console "Customize" tab: the same presentational pet-settings
// controls as Settings → Pet (look / appearance / interaction / sound / care),
// bound to the persisted PetSettings via the settings store. The desktop card is
// Tauri-only and stays hidden in the browser.
const meta = {
  title: "Pet/Console/CustomizeTab",
  component: CustomizeTab,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CustomizeTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
