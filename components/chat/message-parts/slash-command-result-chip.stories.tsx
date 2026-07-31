import type { Meta, StoryObj } from "@storybook/nextjs"

import { SlashCommandResultChip } from "./slash-command-result-chip"
import type { SlashCommandResultBlock } from "@/lib/slash-commands/system-blocks"

const meta = {
  title: "Chat/MessageParts/SlashCommandResultChip",
  component: SlashCommandResultChip,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SlashCommandResultChip>

export default meta
type Story = StoryObj<typeof meta>

// Command with an argument string and an explicit summary.
export const WithArgsAndSummary: Story = {
  args: {
    block: {
      kind: "slash-result",
      commandId: "resume",
      args: "session-3f9",
      summary: "Resumed the previous session (12 messages restored).",
    } satisfies SlashCommandResultBlock,
  },
}

// Bare command — falls through to the default i18n summary.
export const BareCommand: Story = {
  args: {
    block: { kind: "slash-result", commandId: "clear" } satisfies SlashCommandResultBlock,
  },
}
