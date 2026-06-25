import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { WebSearchCard } from "./web-search-card"

function makePart(input: unknown, output: unknown): ToolUIPart {
  return {
    type: "tool-WebSearch",
    toolCallId: "c1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/WebSearchCard",
  component: WebSearchCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WebSearchCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    part: makePart(
      { query: "next-intl static export caveats" },
      {
        results: [
          {
            title: "Internationalization in Next.js with next-intl",
            url: "https://next-intl.dev/docs/getting-started",
            snippet:
              "next-intl provides a complete solution for translating your Next.js app, including App Router and static export support.",
          },
          {
            title: "Static export — App Router",
            url: "https://nextjs.org/docs/app/guides/static-exports",
            description:
              "output: 'export' produces a fully static site with no server runtime; API routes are not available.",
          },
        ],
      }
    ),
  },
}

export const EmptyResults: Story = {
  args: {
    part: makePart({ query: "an extremely obscure query with zero hits" }, { results: [] }),
  },
}
