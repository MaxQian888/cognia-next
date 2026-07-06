import type { Meta, StoryObj } from "@storybook/nextjs"

import { RuntimeTab } from "./runtime-tab"
import { seedDb } from "@/lib/storybook/seed-db"

// `RuntimeTab` edits the global A2UI defaults (enabled, default catalog, widget
// host strategy + theme, persistence limit) that apply when a character /
// session does not override them. It loads the AppSettings singleton via
// `getSettings()` and persists with `saveSettings`.
const meta = {
  title: "Settings/A2UI/RuntimeTab",
  component: RuntimeTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RuntimeTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
