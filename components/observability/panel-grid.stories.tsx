import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PanelGrid } from "./panel-grid"
import { PanelFrame } from "./panel-frame"
import { defaultLayouts } from "./panel-registry"

// `PanelGrid` is the react-grid-layout (v2) wrapper that renders one
// draggable/resizable cell per registry panel. Pure props-only — it measures
// its container via ResizeObserver (available in the Storybook browser) and
// renders each panel through the `renderPanel` callback. Stories cover the
// locked (view) and edit (drag handles + resize) modes.
const meta = {
  title: "Observability/PanelGrid",
  component: PanelGrid,
  args: {
    layouts: defaultLayouts(),
    editMode: false,
    onLayoutChange: fn(),
    renderPanel: (panel) => (
      <PanelFrame title={panel.titleKey} editMode={false} data-testid={`grid-panel-${panel.id}`}>
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {panel.kind}
        </div>
      </PanelFrame>
    ),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full overflow-auto p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PanelGrid>

export default meta
type Story = StoryObj<typeof meta>

export const Locked: Story = {}

export const EditMode: Story = {
  args: {
    editMode: true,
    renderPanel: (panel) => (
      <PanelFrame title={panel.titleKey} editMode data-testid={`grid-panel-${panel.id}`}>
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {panel.kind}
        </div>
      </PanelFrame>
    ),
  },
}
