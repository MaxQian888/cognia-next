import type { Meta, StoryObj } from "@storybook/nextjs"

import { OverviewTab } from "./overview-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { seedDb } from "@/lib/storybook/seed-db"
import { useA2UIStore } from "@/stores/a2ui"

// `OverviewTab` is the A2UI dashboard: app/surface/event counts (apps + events
// from Dexie, surfaces from `useA2UIStore`) plus a recent-apps list and a CTA
// into the Hub. On an empty database the counts are zero and the recent list
// shows its empty card.
const meta = {
  title: "Settings/A2UI/OverviewTab",
  component: OverviewTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    resetStore(useA2UIStore)
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
