import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { StructuredToolPart } from "./structured-tool-part"

const toolPart = (
  type: string,
  state: ToolUIPart["state"],
  extra: Record<string, unknown> = {}
): ToolUIPart =>
  ({
    type,
    toolCallId: "call-1",
    state,
    input: {},
    ...extra,
  }) as unknown as ToolUIPart

const meta = {
  title: "Chat/MessageParts/StructuredToolPart",
  component: StructuredToolPart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof StructuredToolPart>

export default meta
type Story = StoryObj<typeof meta>

// The compact row every non-Bash / non-file tool renders: status dot +
// colored verb + icon + mono target + meta, expanding into ToolDetailBody.
export const WebFetch: Story = {
  args: {
    part: toolPart("tool-WebFetch", "output-available", {
      input: { url: "https://elements.ai-sdk.dev/components/terminal" },
      output: JSON.stringify({ status: 200, title: "Terminal — AI Elements" }),
    }),
  },
}

export const WebSearch: Story = {
  args: {
    part: toolPart("tool-WebSearch", "output-available", {
      input: { query: "ai elements terminal component" },
      output: JSON.stringify({
        ok: true,
        provider: "tavily",
        results: [
          { title: "Terminal", url: "https://elements.ai-sdk.dev/components/terminal" },
          { title: "AI Elements docs", url: "https://elements.ai-sdk.dev" },
        ],
      }),
    }),
  },
}

export const WikiSearchRunning: Story = {
  args: {
    part: toolPart("tool-mcp__cognia-tools__wiki_search", "input-available", {
      input: { query: "message stream architecture" },
    }),
  },
}

export const RagSearch: Story = {
  args: {
    part: toolPart("tool-mcp__cognia-tools__rag_search", "output-available", {
      input: { query: "tool row design" },
      output: JSON.stringify({
        hits: [
          {
            id: "c1",
            sourceTitle: "ADR-0155",
            scope: "docs",
            score: 0.91,
            content: "Inline rows…",
          },
        ],
      }),
    }),
  },
}

// Unknown plugin/MCP tools degrade to the generic spec — humanized verb,
// summarized target/meta, ToolDetailBody expansion.
export const UnknownTool: Story = {
  args: {
    part: toolPart("tool-mcp__acme__deploy_preview", "output-available", {
      input: { url: "https://preview.acme.dev/42" },
      output: JSON.stringify({ ok: true }),
    }),
  },
}

export const Denied: Story = {
  args: {
    part: toolPart("tool-WebFetch", "output-denied", {
      input: { url: "https://intranet.corp/wiki" },
    }),
  },
}
