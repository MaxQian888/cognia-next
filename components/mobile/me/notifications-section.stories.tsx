import type { Meta, StoryObj } from "@storybook/nextjs"

import { NotificationsSection } from "./notifications-section"

// Notifications block on the /me screen: the permission CTA (which renders its
// web/fallback branch in the Storybook browser) plus the row that opens the
// scheduled-reminders queue sheet.
const meta = {
  title: "Mobile/Me/NotificationsSection",
  component: NotificationsSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationsSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
