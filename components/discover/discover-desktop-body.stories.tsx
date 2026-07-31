import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverDesktopBody } from "./discover-desktop-body"
import { seedDb } from "@/lib/storybook/seed-db"

// Full desktop Discover page (sidebar / grid / inspector in a FeaturePageShell).
// Category + selected item live in the URL via `useDiscoverRouteState`; items
// come from `useDiscoverQuery` over the local catalog. The built-in seed
// (characters / skills / teams) gives the grid real content.
const meta = {
  title: "Discover/DiscoverDesktopBody",
  component: DiscoverDesktopBody,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverDesktopBody>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
