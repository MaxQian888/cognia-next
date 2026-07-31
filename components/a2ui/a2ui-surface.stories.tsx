import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UISurface } from "./a2ui-surface"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// A2UISurface reads its component tree from the A2UI Zustand store. Each story
// resets the store and seeds a single ready surface so the renderer paints a
// real Card → Text/Button tree.
const meta = {
  title: "A2UI/Surface",
  component: A2UISurface,
  parameters: { layout: "centered" },
  args: { surfaceId: "story-surface" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UISurface>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ReadOnly: Story = { args: { readOnly: true } }

export const NotFound: Story = {
  args: { surfaceId: "missing-surface" },
}
