import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasShell } from "./canvas-shell"
import { resetStores, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { makeCanvasDocument, makeMarkdownDocument } from "@/lib/storybook/fixtures/canvas"

// CanvasShell owns the full resizable 3-pane Canvas layout: document rail,
// editor workspace (Monaco), and the tools side rail. It picks a desktop vs.
// mobile branch from `useIsMobile()` and reads `useCanvasLayoutStore` for pane
// sizing. Reset both canvas stores; seed documents per story. Needs a tall
// container so the resizable panes have height.
const meta = {
  title: "Canvas/Shell",
  component: CanvasShell,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStores(useArtifactStore, useCanvasLayoutStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasShell>

export default meta
type Story = StoryObj<typeof meta>

// No documents → rail empty state + workspace first-run empty state.
export const Empty: Story = {}

// Several documents with one active → rail list, editor, and tools rail.
export const Populated: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: {
        "doc-1": makeMarkdownDocument({ id: "doc-1", title: "Project Brief" }),
        "doc-2": makeCanvasDocument({ id: "doc-2", title: "index.ts" }),
        "doc-3": makeCanvasDocument({ id: "doc-3", title: "server.py", language: "python" }),
      },
      activeCanvasId: "doc-2",
    })
  },
}
