import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { GrepCard } from "./grep-card"

function makePart(input: unknown, output: unknown): ToolUIPart {
  return {
    type: "tool-Grep",
    toolCallId: "grep-1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/GrepCard",
  component: GrepCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof GrepCard>

export default meta
type Story = StoryObj<typeof meta>

// Pattern + glob scope + output_mode in the header, content lines as matches.
export const ContentMatches: Story = {
  args: {
    part: makePart(
      { pattern: "useTranslations", glob: "*.tsx", output_mode: "content" },
      [
        "components/chat/glob-card.tsx:3:import { useTranslations } from",
        "components/chat/grep-card.tsx:3:import { useTranslations } from",
      ].join("\n")
    ),
  },
}

// files_with_matches mode via structured { files } output.
export const FilesMode: Story = {
  args: {
    part: makePart(
      { pattern: "TODO", path: "lib", output_mode: "files_with_matches" },
      { files: ["lib/sync/queue.ts", "lib/twin/ingest/redact.ts"] }
    ),
  },
}

// Pattern with no hits — renders the "no matches" message.
export const NoMatches: Story = {
  args: {
    part: makePart({ pattern: "zzz_never_matches" }, ""),
  },
}
