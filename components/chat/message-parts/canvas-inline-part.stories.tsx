import type { Meta, StoryObj } from "@storybook/nextjs"

import { CanvasInlinePart } from "./canvas-inline-part"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasDocument } from "@/types"
import type { CanvasInlinePart as CanvasInlinePartType } from "@/lib/claude/parts-extensions"

// `CanvasInlinePart` reads the live Canvas document from
// `useArtifactStore.canvasDocuments` by id and renders a low-height read-only
// preview (CodeBlock for `type: "code"`, markdown for `type: "text"`). Each
// story seeds `canvasDocuments` directly via `setState`; the "missing" story
// seeds nothing to exercise the cleared placeholder. The editable Canvas
// surface lives at `/canvas/<id>` — the inline view is intentionally static.

const CODE_ID = "canvas-code-1"
const TEXT_ID = "canvas-text-1"

const baseDoc = (over: Partial<CanvasDocument>): CanvasDocument => ({
  id: "x",
  sessionId: "demo-session",
  title: "Untitled",
  content: "",
  language: "plaintext",
  type: "text",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
})

const codeDoc = baseDoc({
  id: CODE_ID,
  title: "rate-limit.ts",
  type: "code",
  language: "typescript",
  content: `export function tokenBucket(capacity: number, refillPerSecond: number) {
  let tokens = capacity
  let last = Date.now()
  return () => {
    const now = Date.now()
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSecond)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}
`,
})

const textDoc = baseDoc({
  id: TEXT_ID,
  title: "Launch announcement",
  type: "text",
  language: "markdown",
  content: [
    "# Cognia 2.4 is here",
    "",
    "This release ships the **unified subscription flow** and a faster vector store.",
    "",
    "1. One-tap tier upgrades",
    "2. Native sqlite-vec search",
    "3. Quiet-hours-aware connectors",
  ].join("\n"),
})

function seed(...docs: CanvasDocument[]) {
  useArtifactStore.setState({
    canvasDocuments: Object.fromEntries(docs.map((d) => [d.id, d])),
  })
}

const part = (
  over: Partial<CanvasInlinePartType> & { canvasId: string }
): CanvasInlinePartType => ({
  type: "canvas",
  title: "Canvas",
  ...over,
})

const meta = {
  title: "Chat/MessageParts/CanvasInlinePart",
  component: CanvasInlinePart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CanvasInlinePart>

export default meta
type Story = StoryObj<typeof meta>

// Code canvas — syntax-highlighted CodeBlock with line numbers, read-only.
export const CodeDocument: Story = {
  args: {
    part: part({ canvasId: CODE_ID, title: "rate-limit.ts", readonly: true }),
  },
  beforeEach: () => seed(codeDoc),
}

// Text canvas — markdown rendered in the inline preview body.
export const TextDocument: Story = {
  args: {
    part: part({ canvasId: TEXT_ID, title: "Launch announcement" }),
  },
  beforeEach: () => seed(textDoc),
}

// The document is no longer in the store — the dashed cleared placeholder.
export const Cleared: Story = {
  args: {
    part: part({ canvasId: "gone-7", title: "Draft spec" }),
  },
  beforeEach: () => seed(),
}
