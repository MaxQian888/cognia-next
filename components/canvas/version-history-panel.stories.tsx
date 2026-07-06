import type { Meta, StoryObj } from "@storybook/nextjs"

import { VersionHistoryPanel } from "./version-history-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeCanvasDocument, makeCanvasVersion } from "@/lib/storybook/fixtures/canvas"

// VersionHistoryPanel renders a trigger button that opens a Sheet listing the
// document's saved versions (preview / restore / delete, plus a compare mode).
// It reads versions from `useArtifactStore`; click the trigger to open the
// Sheet. The store is reset and seeded with the document + versions per story.
const documentId = "doc-1"

const meta = {
  title: "Canvas/VersionHistoryPanel",
  component: VersionHistoryPanel,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useArtifactStore)
  },
  args: { documentId },
} satisfies Meta<typeof VersionHistoryPanel>

export default meta
type Story = StoryObj<typeof meta>

// Document with a handful of versions (current + auto-saves). Open to inspect.
export const WithVersions: Story = {
  beforeEach: () => {
    const versions = [
      makeCanvasVersion({ id: "v1", description: "Initial draft" }),
      makeCanvasVersion({ id: "v2", description: "Auto-save", isAutoSave: true }),
      makeCanvasVersion({ id: "v3", description: "Add error handling" }),
    ]
    seedStore(useArtifactStore, {
      canvasDocuments: {
        [documentId]: makeCanvasDocument({ id: documentId, versions, currentVersionId: "v3" }),
      },
      activeCanvasId: documentId,
    })
  },
}

// Many versions to exercise the date grouping and compare mode (≥2 versions).
export const ManyVersions: Story = {
  beforeEach: () => {
    const versions = Array.from({ length: 8 }, (_, i) =>
      makeCanvasVersion({
        id: `v${i + 1}`,
        description: i % 2 === 0 ? `Edit pass ${i + 1}` : "Auto-save",
        isAutoSave: i % 2 !== 0,
      })
    )
    seedStore(useArtifactStore, {
      canvasDocuments: {
        [documentId]: makeCanvasDocument({ id: documentId, versions }),
      },
      activeCanvasId: documentId,
    })
  },
}

// No versions yet → the Sheet shows the "no versions" empty state.
export const NoVersions: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: { [documentId]: makeCanvasDocument({ id: documentId, versions: [] }) },
      activeCanvasId: documentId,
    })
  },
}
