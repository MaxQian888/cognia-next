import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasWorkspace } from "./canvas-workspace"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeCanvasDocument } from "@/lib/storybook/fixtures/canvas"

// CanvasWorkspace is the editor container: it shows CanvasEmptyState when no
// canvas documents exist and CanvasPanel (Monaco) otherwise, wrapped in the
// canvas error boundary. State comes from `useArtifactStore`.
const meta = {
  title: "Canvas/Workspace",
  component: CanvasWorkspace,
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
} satisfies Meta<typeof CanvasWorkspace>

export default meta
type Story = StoryObj<typeof meta>

// No documents → first-run empty state with the create CTA.
export const Empty: Story = {}

// At least one document → the workspace mounts the editor panel.
export const WithDocument: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: { "doc-1": makeCanvasDocument({ id: "doc-1", title: "index.ts" }) },
      activeCanvasId: "doc-1",
    })
  },
}
