import type { Meta, StoryObj } from "@storybook/nextjs"

import { SkillUsageTrend } from "./skill-usage-trend"

// Propless — `useSkillAnalytics` reads usage rows from the (empty in Storybook)
// Dexie DB, so the trend chart renders with no data points.
const meta = {
  title: "Skills/SkillUsageTrend",
  component: SkillUsageTrend,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillUsageTrend>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
