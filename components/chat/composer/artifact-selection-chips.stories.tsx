import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactSelectionChips } from "./artifact-selection-chips"
import { useChatStore } from "@/stores/chat"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { wrapUntrustedRecord } from "@/lib/web/untrusted-content"

// Reads `contextSelections` from the chat store and renders one chip per
// selected snippet. Returns null when empty, so each story seeds the store.
const meta = {
  title: "Chat/Composer/ArtifactSelectionChips",
  component: ArtifactSelectionChips,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useChatStore)
    seedStore(useChatStore, {
      contextSelections: [
        {
          kind: "artifact",
          artifactId: "a1",
          title: "pipeline.ts",
          snapshot: "export const stages = ['ingest', 'embed', 'route']",
          comment: "rename `stages` to `phases`",
          range: { startLine: 12, endLine: 12 },
        },
        {
          kind: "artifact",
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
      contextSelections: [
        {
          kind: "artifact",
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

// The summary shares the file preview's frame, with only the readable body in it.
export const SummaryPreview: Story = {
  globals: { locale: "zh-CN", theme: "dark" },
  beforeEach: () => {
    resetStore(useChatStore)
    seedStore(useChatStore, {
      contextSelections: [
        {
          kind: "entity",
          entityKind: "message",
          entityId: "preview-session#preview-message",
          title: "对话摘要预览",
          snapshot: wrapUntrustedRecord(
            Array.from(
              { length: 12 },
              (_, index) =>
                `${index + 1}. 预览体验\n摘要与文件使用相同的固定尺寸和紧凑工具栏。正文在弹窗内部滚动，复制与下载只包含摘要内容。`
            ).join("\n\n")
          ),
          comment: "",
          capturedAt: 1,
          excerpt: { derivation: "summary", quote: "Preview fixture" },
        },
      ],
    })
  },
}
