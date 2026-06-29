import type { Meta, StoryObj } from "@storybook/nextjs"

import { NotificationFeedMobile } from "./notification-feed-mobile"
import { resetStore } from "@/lib/storybook/seed-stores"
import { seedDb } from "@/lib/storybook/seed-db"
import { useNotificationStore } from "@/stores/notifications/notification-store"

// Mobile notification center feed. Propless: it reads `useNotificationStore`,
// which hydrates from Dexie on mount. With an empty DB the feed renders its
// empty state — the deterministic case in the Storybook browser. The store is
// reset between stories so no records leak in from an earlier render.
const meta = {
  title: "Mobile/Notifications/NotificationFeedMobile",
  component: NotificationFeedMobile,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    resetStore(useNotificationStore)
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationFeedMobile>

export default meta
type Story = StoryObj<typeof meta>

/** No notifications — the empty active feed. */
export const Empty: Story = {}
