import type { Meta, StoryObj } from "@storybook/nextjs"

import { TwinInjectLogCard } from "./twin-inject-log-card"

// Reads the in-memory inject-log ring buffer (not Dexie) and filters by twinId.
// The buffer starts empty in Storybook, so this renders the empty diagnostic
// state.
const meta = {
  title: "Twin/InjectLogCard",
  component: TwinInjectLogCard,
  parameters: { layout: "padded" },
  args: { twinId: "twin-1" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TwinInjectLogCard>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
