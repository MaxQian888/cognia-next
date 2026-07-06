import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CanvasDocumentList } from "./canvas-document-list"
import { makeCanvasDocument, makeMarkdownDocument } from "@/lib/storybook/fixtures/canvas"

// CanvasDocumentList is the full document-management panel: search, language
// filter, sort field/order, a create dialog, and per-card rename / duplicate /
// delete. Pure props-only — documents and handlers are injected.
const meta = {
  title: "Canvas/DocumentList",
  component: CanvasDocumentList,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectDocument: fn(),
    onCreateDocument: fn(),
    onRenameDocument: fn(),
    onDuplicateDocument: fn(),
    onDeleteDocument: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-full max-w-md border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasDocumentList>

export default meta
type Story = StoryObj<typeof meta>

const documents = [
  makeMarkdownDocument({ id: "doc-a", title: "Project Brief" }),
  makeCanvasDocument({ id: "doc-b", title: "index.ts", language: "typescript" }),
  makeCanvasDocument({ id: "doc-c", title: "styles.css", language: "css" }),
  makeCanvasDocument({ id: "doc-d", title: "server.py", language: "python" }),
]

// Populated list with the TypeScript document selected.
export const Populated: Story = {
  args: {
    documents,
    activeDocumentId: "doc-b",
  },
}

// Empty list → the "no documents" empty state with a create-first CTA.
export const Empty: Story = {
  args: {
    documents: [],
    activeDocumentId: null,
  },
}

// A single document.
export const SingleDocument: Story = {
  args: {
    documents: [documents[0]],
    activeDocumentId: "doc-a",
  },
}
