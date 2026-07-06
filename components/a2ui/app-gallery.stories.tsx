import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AppGallery } from "./app-gallery"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useA2UIStore } from "@/stores/a2ui"

// AppGallery is driven by the app-builder hook (A2UI store). With a reset store
// it renders its full chrome — header, search, filters, sort — over the empty
// state, which is the gallery's first-run appearance.
const meta = {
  title: "A2UI/AppGallery",
  component: AppGallery,
  parameters: { layout: "fullscreen" },
  args: {
    onAction: fn(),
    onDataChange: fn(),
    onAppOpen: fn(),
  },
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppGallery>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ListView: Story = { args: { defaultViewMode: "list" } }

export const FourColumns: Story = { args: { columns: 4 } }
