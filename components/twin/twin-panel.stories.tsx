import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinPanel } from "./twin-panel"
import { seedDb } from "@/lib/storybook/seed-db"

// Top-level workbench. The active twin is derived from characters that carry a
// `twinId` (`useLiveQuery(listCharacters)`); URL tab state uses the App Router
// mocks supplied by the preview. With no twin-bearing characters it renders the
// "no twin" empty state.
const meta = {
  title: "Twin/TwinPanel",
  component: TwinPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinPanel>

export default meta
type Story = StoryObj<typeof meta>

export const NoTwin: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
