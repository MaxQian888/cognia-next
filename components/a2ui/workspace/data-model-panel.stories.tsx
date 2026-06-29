import type { Meta, StoryObj } from "@storybook/nextjs"

import { DataModelPanel } from "./data-model-panel"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Tree view / inline editor for the surface data model.
const meta = {
  title: "A2UI/Workspace/DataModelPanel",
  component: DataModelPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, {
      surfaces: {
        "story-surface": makeSurfaceState({
          dataModel: {
            user: { name: "Ada", role: "admin" },
            count: 42,
            enabled: true,
            tags: ["a", "b"],
          },
        }),
      },
    })
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[320px] border-l">
        <A2UIWorkspaceProvider surfaceId="story-surface">
          <Story />
        </A2UIWorkspaceProvider>
      </div>
    ),
  ],
} satisfies Meta<typeof DataModelPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const EmptyModel: Story = {
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, {
      surfaces: { "story-surface": makeSurfaceState({ dataModel: {} }) },
    })
  },
}
