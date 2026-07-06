import type { Meta, StoryObj } from "@storybook/nextjs"

import { VersionHistoryPanel } from "./version-history-panel"
import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { makeHistoryEntry } from "@/lib/storybook/fixtures/a2ui"
import { useA2UIStore } from "@/stores/a2ui"

// Undo-history snapshots with restore. Reads the surface's undo stack from the
// store.
const meta = {
  title: "A2UI/Workspace/VersionHistoryPanel",
  component: VersionHistoryPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useA2UIStore)
    seedStore(useA2UIStore, {
      undoStacks: {
        "story-surface": [
          makeHistoryEntry({ id: "e1", description: "Add Card", timestamp: Date.now() - 60_000 }),
          makeHistoryEntry({ id: "e2", description: "Edit Text", timestamp: Date.now() - 30_000 }),
          makeHistoryEntry({ id: "e3", description: "Add Button", timestamp: Date.now() }),
        ],
      },
    })
  },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[300px] border-l">
        <A2UIWorkspaceProvider surfaceId="story-surface">
          <Story />
        </A2UIWorkspaceProvider>
      </div>
    ),
  ],
} satisfies Meta<typeof VersionHistoryPanel>

export default meta
type Story = StoryObj<typeof meta>

export const WithHistory: Story = {}

export const Empty: Story = {
  beforeEach: () => {
    resetStore(useA2UIStore)
  },
}
