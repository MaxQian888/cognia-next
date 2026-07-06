import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DiscoverCardActions } from "./discover-card-actions"
import { makeCharacterDiscoverItem } from "@/lib/storybook/fixtures/mobile-discover"

// Long-press action sheet for the legacy Discover cards. `item: null` keeps it
// closed; a `DiscoverItem` opens the sheet and renders the shared
// "Share via link" flow (its own PII gate + ShareLinkDialog stay closed here).
const meta = {
  title: "Mobile/Discover/DiscoverCardActions",
  component: DiscoverCardActions,
  parameters: { layout: "fullscreen" },
  args: { onOpenChange: fn() },
} satisfies Meta<typeof DiscoverCardActions>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  args: { item: makeCharacterDiscoverItem({ name: "Octopus Tutor" }) },
}

export const Closed: Story = {
  args: { item: null },
}
