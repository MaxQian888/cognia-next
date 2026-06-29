import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileQuickActionsEditor } from "./mobile-quick-actions-editor"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// Editor for the mobile-home customization: Active (drag-reorder + remove) and
// Available (add) lists, section visibility switches, and restore-defaults.
// Reads/writes the layout via `useSettingsStore`; reset → factory default.
const meta = {
  title: "Mobile/Home/MobileQuickActionsEditor",
  component: MobileQuickActionsEditor,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileQuickActionsEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
