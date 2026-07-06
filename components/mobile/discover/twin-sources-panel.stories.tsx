import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinSourcesPanel } from "./twin-sources-panel"
import { seedDb } from "@/lib/storybook/seed-db"

// Twin ingest sources list + the "+" add menu (paste / capture / file). Reads
// the `twinSources` Dexie table live. With an empty DB it shows the header,
// the add CTA, and the empty-state copy. (The native paste/camera paths only
// fire on tap and no-op off the Capacitor shell.)
const meta = {
  title: "Mobile/Discover/TwinSourcesPanel",
  component: TwinSourcesPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto flex w-[390px] flex-col p-4">
        <Story />
      </div>
    ),
  ],
  beforeEach: async () => {
    await seedDb(async () => {})
  },
} satisfies Meta<typeof TwinSourcesPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
