import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { GuildRail } from "./guild-rail"

// 64px Discord-style left rail: account/workspace switchers, DM + Canvas, the
// user-customizable pinned features, dynamic teams (from Dexie), and Settings.
// Hidden below `md`, so the story uses a wide, full-height container. Routing
// reads next/navigation (App Router mocks supplied by the preview).
const meta = {
  title: "Shell/GuildRail",
  component: GuildRail,
  parameters: { layout: "fullscreen" },
  args: { onCreateTeam: fn(), onOpenSettings: fn() },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[200px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GuildRail>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
