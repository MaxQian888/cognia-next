import type { Meta, StoryObj } from "@storybook/nextjs"

import { SuggestionsPanel } from "./suggestions-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeCanvasDocument, makeCanvasSuggestion } from "@/lib/storybook/fixtures/canvas"

// SuggestionsPanel lists the *pending* suggestions for a document. Apply /
// dismiss route through `useArtifactStore` (apply mutates the seeded document),
// so the store is reset and seeded with the matching canvas document. The panel
// renders nothing when there are no pending suggestions and it isn't generating.
const documentId = "doc-1"

const meta = {
  title: "Canvas/SuggestionsPanel",
  component: SuggestionsPanel,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useArtifactStore)
    seedStore(useArtifactStore, {
      canvasDocuments: { [documentId]: makeCanvasDocument({ id: documentId }) },
      activeCanvasId: documentId,
    })
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md border-t">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SuggestionsPanel>

export default meta
type Story = StoryObj<typeof meta>

// A list of pending suggestions of different types.
export const Pending: Story = {
  args: {
    documentId,
    suggestions: [
      makeCanvasSuggestion({ type: "improve" }),
      makeCanvasSuggestion({
        type: "fix",
        explanation: "Guard against a null name before concatenating.",
      }),
      makeCanvasSuggestion({
        type: "comment",
        originalText: "",
        suggestedText: "",
        explanation: "Document the empty-name edge case.",
      }),
    ],
  },
}

// Generating state — header spinner, no items yet.
export const Generating: Story = {
  args: {
    documentId,
    suggestions: [],
    isGenerating: true,
  },
}

// Only resolved suggestions remain → panel renders nothing (collapses).
export const NoPending: Story = {
  args: {
    documentId,
    suggestions: [makeCanvasSuggestion({ status: "accepted" })],
    isGenerating: false,
  },
}
