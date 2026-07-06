import type { Meta, StoryObj } from "@storybook/nextjs"

import { MemoryMobileBody } from "./memory-mobile-body"
import { seedDb } from "@/lib/storybook/seed-db"

// Mobile long-term Memory view. Reads `memories` live from Dexie with a text
// filter. With an empty DB it renders the search header + empty state — the
// deterministic case in the Storybook browser (the `memories` sync handler is
// dormant here).
const meta = {
  title: "Mobile/Memory/MemoryMobileBody",
  component: MemoryMobileBody,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemoryMobileBody>

export default meta
type Story = StoryObj<typeof meta>

/** No memories synced — search header over an empty state. */
export const Empty: Story = {}
