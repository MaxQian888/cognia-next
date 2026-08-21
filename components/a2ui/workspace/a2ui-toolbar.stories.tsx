import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIToolbar } from "./a2ui-toolbar"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeSurfaceState, makeHistoryEntry } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Workspace action bar, rendered as `WorkspaceHeader`'s secondary band:
// undo/redo, panel toggles, zoom, then AI + the single filled Save primary.
// The edit/preview/data switch is NOT here — the header's tabs own it.
const meta = {
  title: "A2UI/Workspace/Toolbar",
  component: A2UIToolbar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, { surfaces: { "story-surface": makeSurfaceState() } })
  },
  decorators: [
    (Story) => (
      <A2UIWorkspaceProvider surfaceId="story-surface">
        <Story />
      </A2UIWorkspaceProvider>
    ),
  ],
} satisfies Meta<typeof A2UIToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithUndoHistory: Story = {
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, {
      surfaces: { "story-surface": makeSurfaceState() },
      undoStacks: { "story-surface": [makeHistoryEntry()] },
    })
  },
}
