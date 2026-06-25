import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { WebFetchCard } from "./web-fetch-card"

function makePart(input: unknown, output: unknown): ToolUIPart {
  return {
    type: "tool-WebFetch",
    toolCallId: "c1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/WebFetchCard",
  component: WebFetchCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WebFetchCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    part: makePart(
      {
        url: "https://nextjs.org/docs/app/guides/static-exports",
        prompt: "Summarize the limitations of static export",
      },
      {
        content:
          "Static exports (output: 'export') generate an HTML/CSS/JS site at build time. The following features are not supported because they require a server at runtime:\n\n- Dynamic routes without generateStaticParams\n- Route Handlers (app/api)\n- Cookies, headers, redirects, and rewrites read at request time\n- Incremental Static Regeneration\n- Image Optimization with the default loader\n\nUse a custom image loader and pre-render every route to ship a fully static bundle.",
      }
    ),
  },
}

export const Empty: Story = {
  args: {
    part: makePart({ url: "https://example.com/empty-page" }, { content: "" }),
  },
}
