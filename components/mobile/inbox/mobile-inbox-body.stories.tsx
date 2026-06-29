import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileInboxBody } from "./mobile-inbox-body"
import { seedDb } from "@/lib/storybook/seed-db"

// Mobile inbox shell with a segmented Messages / Drafts switcher. `initialTab`
// seeds the active surface; the draft-count badge reads pending drafts live
// from Dexie. Seeded with an empty DB so both surfaces render their empty state.
const meta = {
  title: "Mobile/Inbox/MobileInboxBody",
  component: MobileInboxBody,
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
} satisfies Meta<typeof MobileInboxBody>

export default meta
type Story = StoryObj<typeof meta>

/** Drafts triage tab (mobile-native swipe-approve panel). */
export const Drafts: Story = {
  args: { initialTab: "drafts" },
}

/** Messages tab (responsive InboxShell list). */
export const Messages: Story = {
  args: { initialTab: "messages" },
}
