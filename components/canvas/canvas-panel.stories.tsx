import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasPanel } from "./canvas-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { makeCanvasDocument, makeMarkdownDocument } from "@/lib/storybook/fixtures/canvas"

// CanvasPanel is the central editor surface. On desktop it lazy-loads the
// Monaco editor (dynamic import, ssr:false) with the AI-action toolbar on top;
// the editor view streams in behind a Suspense spinner, so the panel renders
// immediately even before Monaco is ready. State (documents + active id) comes
// from `useArtifactStore`, reset and seeded per story. Given a sized,
// fullscreen container as Monaco needs explicit dimensions.
const meta = {
  title: "Canvas/Panel",
  component: CanvasPanel,
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
} satisfies Meta<typeof CanvasPanel>

export default meta
type Story = StoryObj<typeof meta>

// A single active TypeScript document — toolbar + editor (Monaco loads in).
export const SingleDocument: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: { "doc-1": makeCanvasDocument({ id: "doc-1", title: "index.ts" }) },
      activeCanvasId: "doc-1",
    })
  },
}

// Multiple documents → the toolbar shows the tab strip.
export const MultipleDocuments: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: {
        "doc-1": makeMarkdownDocument({ id: "doc-1", title: "README.md" }),
        "doc-2": makeCanvasDocument({ id: "doc-2", title: "index.ts" }),
        "doc-3": makeCanvasDocument({ id: "doc-3", title: "styles.css", language: "css" }),
      },
      activeCanvasId: "doc-2",
    })
  },
}

// Documents exist but none is active → the panel's "select or create" empty
// body (the toolbar still renders).
export const NoActiveDocument: Story = {
  beforeEach: () => {
    seedStore(useArtifactStore, {
      canvasDocuments: { "doc-1": makeCanvasDocument({ id: "doc-1" }) },
      activeCanvasId: null,
    })
  },
}
