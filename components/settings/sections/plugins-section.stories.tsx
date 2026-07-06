import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginsSection } from "./plugins-section"
import { clearDb } from "@/lib/storybook/seed-db"

// Dexie-reading: a compact launcher whose status badges count rows from the
// `plugins` table via `useLiveQuery(listPlugins)`. With an empty IndexedDB the
// badges read 0 enabled / 0 updates / 0 errors and the workspace links render.
// `onClose` is a spy.
const meta = {
  title: "Settings/Sections/PluginsSection",
  component: PluginsSection,
  parameters: { layout: "padded" },
  args: { onClose: fn() },
  beforeEach: async () => {
    await clearDb()
  },
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginsSection>

export default meta
type Story = StoryObj<typeof meta>

// Empty plugin registry → zeroed badges + workspace launch links.
export const Default: Story = {}
