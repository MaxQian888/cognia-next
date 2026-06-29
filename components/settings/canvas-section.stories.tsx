import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasSection } from "./canvas-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

// `CanvasSection` is the eight-tab Canvas settings surface (Editor / AI /
// Versioning / Collaboration / Execution / Accessibility / Keybindings / Theme),
// every control bound to `useCanvasSettingsStore`. Reset to defaults between
// stories so prior edits don't leak across renders.
const meta = {
  title: "Settings/CanvasSection",
  component: CanvasSection,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useCanvasSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] overflow-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
