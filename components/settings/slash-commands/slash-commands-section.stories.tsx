import type { Meta, StoryObj } from "@storybook/nextjs"

import { SlashCommandsSection } from "./slash-commands-section"

// Unified slash-command settings panel: built-in commands (always present),
// custom `.claude/commands/*.md` (desktop-only — empty in the browser), and
// plugin-registered commands. The "+ New / Edit / Delete" affordances are
// gated behind `isTauri()`. No props.
const meta = {
  title: "Settings/SlashCommands/SlashCommandsSection",
  component: SlashCommandsSection,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SlashCommandsSection>

export default meta
type Story = StoryObj<typeof meta>

// Web branch: built-in commands listed, custom group empty / read-only.
export const Default: Story = {}
