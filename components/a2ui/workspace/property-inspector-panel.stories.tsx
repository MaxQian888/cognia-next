import type { Meta, StoryObj } from "@storybook/nextjs"

import { PropertyInspectorPanel } from "./property-inspector-panel"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Property editor for the selected component. Selection is internal workspace
// state (starts empty), so the default story shows the no-selection prompt.
const meta = {
  title: "A2UI/Workspace/PropertyInspectorPanel",
  component: PropertyInspectorPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
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
} satisfies Meta<typeof PropertyInspectorPanel>

export default meta
type Story = StoryObj<typeof meta>

export const NoSelection: Story = {}
