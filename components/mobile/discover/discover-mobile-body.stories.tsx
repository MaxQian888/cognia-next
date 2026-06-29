import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverMobileBody } from "./discover-mobile-body"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// The full mobile Discover surface: header + search + category chip strip,
// then the active category's list. Reads characters / skills / teams live from
// Dexie (the built-in seed populates them) and category/sort/filter from the
// URL (mocked by the preview App Router). Defaults to the Characters tab.
const meta = {
  title: "Mobile/Discover/DiscoverMobileBody",
  component: DiscoverMobileBody,
  parameters: { layout: "fullscreen" },
  beforeEach: async () => {
    resetStore(useWorkflowLibraryStore)
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-hidden border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverMobileBody>

export default meta
type Story = StoryObj<typeof meta>

// Characters tab populated by the built-in Dexie seed.
export const Default: Story = {}
