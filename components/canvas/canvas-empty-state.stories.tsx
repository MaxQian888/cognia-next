import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasEmptyState } from "./canvas-empty-state"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

// `CanvasEmptyState` is propless — it subscribes to `useArtifactStore` for the
// create/activate actions fired by its CTA. Reset the store between stories so
// no canvas state leaks in from an earlier render.
const meta = {
  title: "Canvas/EmptyState",
  component: CanvasEmptyState,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasEmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
