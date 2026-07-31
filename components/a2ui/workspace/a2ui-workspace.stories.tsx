import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIWorkspace } from "./a2ui-workspace"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Full three-panel A2UI editing workspace (tree | preview | properties). Seeds a
// ready surface in the store so every panel has content to show.
const meta = {
  title: "A2UI/Workspace/Workspace",
  component: A2UIWorkspace,
  parameters: { layout: "fullscreen" },
  args: { surfaceId: "story-surface" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIWorkspace>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
