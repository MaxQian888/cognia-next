import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComponentTreePanel } from "./component-tree-panel"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Recursive tree view of the seeded surface's component hierarchy.
const meta = {
  title: "A2UI/Workspace/ComponentTreePanel",
  component: ComponentTreePanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[280px] border-r">
        <A2UIWorkspaceProvider surfaceId="story-surface">
          <Story />
        </A2UIWorkspaceProvider>
      </div>
    ),
  ],
} satisfies Meta<typeof ComponentTreePanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoSurface: Story = {
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[280px] border-r">
        <A2UIWorkspaceProvider surfaceId="missing-surface">
          <Story />
        </A2UIWorkspaceProvider>
      </div>
    ),
  ],
}
