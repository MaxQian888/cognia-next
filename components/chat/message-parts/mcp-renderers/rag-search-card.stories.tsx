import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { RagSearchCard } from "./rag-search-card"

function makePart(output: unknown): ToolUIPart {
  return {
    type: "tool-rag_search",
    toolCallId: "c1",
    state: "output-available",
    input: { query: "vector store location" },
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/RagSearchCard",
  component: RagSearchCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof RagSearchCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    part: makePart({
      hits: [
        {
          id: "chunk-1",
          sourceTitle: "ADR-0024 OCR subsystem",
          scope: "workspace",
          score: 0.91,
          content:
            "The native vector store uses sqlite-vec at <app_data>/cognia/vectors.sqlite. Web mode hides the native option and forces the cloud backend.",
        },
        {
          id: "chunk-2",
          sourceTitle: "CLAUDE.md",
          scope: "global",
          score: 0.77,
          content:
            "Server-only vector-DB SDKs are aliased to lib/browser-stubs/empty.js in next.config.ts so the mobile bundle never pulls them in.",
        },
      ],
    }),
  },
}

export const NoMatches: Story = {
  args: { part: makePart({ hits: [] }) },
}
