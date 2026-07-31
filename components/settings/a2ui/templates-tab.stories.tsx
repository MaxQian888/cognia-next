import type { Meta, StoryObj } from "@storybook/nextjs"

import { TemplatesTab } from "./templates-tab"
import { seedDb } from "@/lib/storybook/seed-db"

// `TemplatesTab` lists the built-in A2UI templates (read-only) alongside
// user-defined templates from the Dexie `a2uiTemplates` table, with import /
// export / delete. On an empty database the user section shows its empty state
// while the built-in section lists the shipped templates.
const meta = {
  title: "Settings/A2UI/TemplatesTab",
  component: TemplatesTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplatesTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
