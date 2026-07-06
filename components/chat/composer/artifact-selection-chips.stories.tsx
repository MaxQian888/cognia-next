import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { useChatStore } from "@/stores/chat"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"

// Reads `artifactSelections` from the chat store and renders one chip per
// selected snippet. Returns null when empty, so each story seeds the store.
const meta = {
  title: "Chat/Composer/ArtifactSelectionChips",
  component: ArtifactSelectionChips,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useChatStore)
    seedStore(useChatStore, {
      artifactSelections: [
        {
          artifactId: "a1",
          title: "pipeline.ts",
          snapshot: "export const stages = ['ingest', 'embed', 'route']",
          comment: "rename `stages` to `phases`",
          range: { startLine: 12, endLine: 12 },
        },
        {
          artifactId: "a2",
          title: "router.ts",
          snapshot: "function route(req) { ... }",
          comment: "",
          range: { startLine: 40, endLine: 58 },
        },
      ],
    })
  },
} satisfies Meta<typeof ArtifactSelectionChips>

export default meta
type Story = StoryObj<typeof meta>

// Two selected snippets, padded container.
export const TwoSelections: Story = {}

// Bare (no padded wrapper) — how it composes inside ContextChipBar.
export const Bare: Story = {
  args: { bare: true },
}

// A single selection.
export const Single: Story = {
  beforeEach: () => {
    resetStore(useChatStore)
    seedStore(useChatStore, {
      artifactSelections: [
        {
          artifactId: "a1",
          title: "config.json",
          snapshot: '{ "port": 3000 }',
          comment: "make the port configurable",
          range: { startLine: 2, endLine: 2 },
        },
      ],
    })
  },
}
