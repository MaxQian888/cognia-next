import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasDocumentRail } from "./canvas-document-rail"
import { resetStores, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { makeCanvasDocument, makeMarkdownDocument } from "@/lib/storybook/fixtures/canvas"

// CanvasDocumentRail is the left rail: time-grouped document list with search,
// language filter chips, sort menu, pinning, and per-doc context menu. It reads
// `useArtifactStore` (documents + active id) and `useCanvasLayoutStore` (pins),
// so both are reset; document/pin state is seeded per story.
const now = Date.now()

const meta = {
  title: "Canvas/DocumentRail",
  component: CanvasDocumentRail,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStores(useArtifactStore, useCanvasLayoutStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasDocumentRail>

export default meta
type Story = StoryObj<typeof meta>

// Several documents spread across the time buckets (Today / Yesterday / Older).
export const Populated: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: {
        "doc-today": makeMarkdownDocument({
          id: "doc-today",
          title: "Project Brief",
          updatedAt: new Date(now),
        }),
        "doc-today-2": makeCanvasDocument({
          id: "doc-today-2",
          title: "index.ts",
          updatedAt: new Date(now - 3_600_000),
        }),
        "doc-yesterday": makeCanvasDocument({
          id: "doc-yesterday",
          title: "server.py",
          language: "python",
          updatedAt: new Date(now - 26 * 3_600_000),
        }),
        "doc-older": makeCanvasDocument({
          id: "doc-older",
          title: "legacy.css",
          language: "css",
          updatedAt: new Date(now - 30 * 86_400_000),
        }),
      },
      activeCanvasId: "doc-today-2",
    })
  },
}

// A pinned document surfaces in its own "Pinned" group at the top.
export const WithPinned: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: {
        "doc-1": makeCanvasDocument({ id: "doc-1", title: "index.ts", updatedAt: new Date(now) }),
        "doc-2": makeMarkdownDocument({
          id: "doc-2",
          title: "Pinned notes",
          updatedAt: new Date(now - 5 * 86_400_000),
        }),
      },
      activeCanvasId: "doc-1",
    })
    seedStore(useCanvasLayoutStore, { pinnedDocIds: new Set(["doc-2"]) })
  },
}

// No documents → empty state inside the rail.
export const Empty: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, { canvasDocuments: {}, activeCanvasId: null })
  },
}
