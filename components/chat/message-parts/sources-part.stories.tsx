import type { Meta, StoryObj } from "@storybook/nextjs"

import { SourcesPart } from "./sources-part"
import type { SourcesPart as SourcesPartType, SourcesPartItem } from "@/lib/claude/parts-extensions"

const twinRag: SourcesPartItem = {
  id: "chunk-1",
  title: "Q3 planning notes",
  snippet:
    "Ship the unified subscription flow before the marketing push; gate overage behind the new tier check.",
  origin: "twin-rag",
  score: 0.91,
  chunkRef: { twinId: "twin-1", sourceId: "src-9", chunkId: "vec-42" },
}

const twinStyle: SourcesPartItem = {
  id: "style-1",
  title: "Style sample — internal memo",
  snippet: "Keep it terse. Lead with the decision, then the why.",
  origin: "twin-style",
  score: 0.77,
}

const memory: SourcesPartItem = {
  id: "mem-1",
  title: "Recalled: user prefers metric units",
  origin: "memory",
}

const webCitation: SourcesPartItem = {
  id: "cite-1",
  title: "Next.js static export — official docs",
  url: "https://nextjs.org/docs/app/guides/static-exports",
  snippet: "output: 'export' produces a fully static site at build time.",
  origin: "anthropic",
}

const footnote: SourcesPartItem = {
  id: "fn-1",
  title: "[1] Tailwind v4 release notes",
  origin: "footnote",
}

const meta = {
  title: "Chat/MessageParts/SourcesPart",
  component: SourcesPart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SourcesPart>

export default meta
type Story = StoryObj<typeof meta>

// Mixed origins — web citation + footnote → collapsed strip by default.
export const MixedCitations: Story = {
  args: {
    part: { type: "sources", sources: [webCitation, footnote] } satisfies SourcesPartType,
  },
}

// Twin-only retrieval feedback (rag + style + memory) → auto-expanded sections.
export const TwinRetrieval: Story = {
  args: {
    part: {
      type: "sources",
      sources: [twinRag, twinStyle, memory],
    } satisfies SourcesPartType,
  },
}

// Degraded twin turn with no retrieved sources — only the amber warning shows.
export const DegradedNoSources: Story = {
  args: {
    part: { type: "sources", sources: [], twinDegraded: true } satisfies SourcesPartType,
  },
}
