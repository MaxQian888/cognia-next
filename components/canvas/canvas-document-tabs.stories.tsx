import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CanvasDocumentTabs } from "./canvas-document-tabs"
import { makeCanvasDocument, makeMarkdownDocument } from "@/lib/storybook/fixtures/canvas"

// CanvasDocumentTabs is a pure tab bar. It renders nothing for 0 or 1
// documents (the single-doc case shows no tabs), so every meaningful story
// passes at least two documents. Per-tab dropdown offers rename / duplicate /
// delete; the trailing "+" creates a new document.
const meta = {
  title: "Canvas/DocumentTabs",
  component: CanvasDocumentTabs,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectDocument: fn(),
    onCloseDocument: fn(),
    onCreateDocument: fn(),
    onRenameDocument: fn(),
    onDuplicateDocument: fn(),
    onDeleteDocument: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CanvasDocumentTabs>

export default meta
type Story = StoryObj<typeof meta>

const docs = [
  makeMarkdownDocument({ id: "doc-a", title: "README.md" }),
  makeCanvasDocument({ id: "doc-b", title: "index.ts", language: "typescript" }),
  makeCanvasDocument({ id: "doc-c", title: "styles.css", language: "css", type: "code" }),
]

// Three open documents with the second one active.
export const MultipleDocuments: Story = {
  args: {
    documents: docs,
    activeDocumentId: "doc-b",
  },
}

// Many documents to exercise the horizontal scroll affordance.
export const ManyDocuments: Story = {
  args: {
    documents: [
      ...docs,
      makeCanvasDocument({ id: "doc-d", title: "server.ts" }),
      makeCanvasDocument({ id: "doc-e", title: "client.ts" }),
      makeCanvasDocument({ id: "doc-f", title: "utils.ts" }),
      makeMarkdownDocument({ id: "doc-g", title: "CHANGELOG.md" }),
    ],
    activeDocumentId: "doc-a",
  },
}

// A single document renders no tab bar (component returns null) — documents the
// boundary where the tabs disappear.
export const SingleDocumentHidden: Story = {
  args: {
    documents: [docs[0]],
    activeDocumentId: "doc-a",
  },
}
