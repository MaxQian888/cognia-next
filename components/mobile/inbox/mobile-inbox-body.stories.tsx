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
      // The body fills the compact shell's definite-height column (`/inbox`
      // owns the viewport), so the story supplies one.
      <div className="mx-auto flex h-[780px] w-[390px] flex-col">
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

/** A scoped route (`/inbox/platform?kind=slack`): the list is filtered and says so. */
export const ScopedToPlatform: Story = {
  args: { initialTab: "messages", platformKind: "slack" },
}
