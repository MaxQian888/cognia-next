import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasSidePanels } from "./canvas-side-panels"
import { resetStores, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCommentStore } from "@/stores/canvas/comment-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import {
  makeCanvasComment,
  makeCanvasDocument,
  makeCanvasSuggestion,
  makeCanvasVersion,
} from "@/lib/storybook/fixtures/canvas"

// CanvasSidePanels is the right rail: Suggestions / History / Comments /
// Collaboration / Execution tabs with badge counts. It reads the artifact,
// comment, and layout stores. Stories drive the active tab via the layout
// store and seed the matching document state. (Collaboration / Execution tabs
// mount editor-runtime hooks, so the stories stay on the data-only tabs.)
const documentId = "doc-1"

function seedDocument(over = {}) {
  seedStore(useArtifactStore, {
    canvasDocuments: { [documentId]: makeCanvasDocument({ id: documentId, ...over }) },
    activeCanvasId: documentId,
  })
}

const meta = {
  title: "Canvas/SidePanels",
  component: CanvasSidePanels,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStores(useArtifactStore, useCommentStore, useCanvasLayoutStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-80 border-l">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasSidePanels>

export default meta
type Story = StoryObj<typeof meta>

// Suggestions tab (default) with several pending suggestions → badge + list.
export const Suggestions: Story = {
  beforeEach: () => {
    seedDocument({
      aiSuggestions: [
        makeCanvasSuggestion({ type: "improve" }),
        makeCanvasSuggestion({ type: "fix", explanation: "Null-guard the input." }),
      ],
    })
  },
}

// History tab with saved versions → version count badge and recent list.
export const History: Story = {
  beforeEach: () => {
    seedDocument({
      versions: [
        makeCanvasVersion({ description: "Initial draft" }),
        makeCanvasVersion({ description: "Auto-save", isAutoSave: true }),
        makeCanvasVersion({ description: "Manual checkpoint" }),
      ],
    })
    seedStore(useCanvasLayoutStore, { activeRightTab: "history" })
  },
}

// Comments tab with unresolved comments seeded into the comment store.
export const Comments: Story = {
  beforeEach: () => {
    seedDocument()
    seedStore(useCommentStore, {
      comments: {
        [documentId]: [
          makeCanvasComment({ documentId }),
          makeCanvasComment({ documentId, authorName: "Grace Hopper" }),
        ],
      },
      loadedDocs: new Set([documentId]),
    })
    seedStore(useCanvasLayoutStore, { activeRightTab: "comments" })
  },
}

// No active document → the rail shows its empty hint.
export const NoActiveDocument: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, { canvasDocuments: {}, activeCanvasId: null })
  },
}
