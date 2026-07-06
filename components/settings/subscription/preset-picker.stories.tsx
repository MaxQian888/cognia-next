import type { Meta, StoryObj } from "@storybook/nextjs"

import { PresetPicker } from "./preset-picker"

// `PresetPicker` reads `useProviderPresets(provider)`, backed by the Tauri
// keyring. In the Storybook (non-Tauri) browser the hook resolves to an empty
// preset library, so the card renders the "no preset" selectable card plus the
// "Add preset" / "New from template" controls. These stories exercise the three
// preset-capable providers (the Anthropic variant additionally exposes the
// fast-model field inside its editor).
const meta = {
  title: "Settings/Subscription/PresetPicker",
  component: PresetPicker,
  args: { provider: "anthropic" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PresetPicker>

export default meta
type Story = StoryObj<typeof meta>

export const Anthropic: Story = {}

export const Codex: Story = {
  args: { provider: "codex" },
}

export const OpenCode: Story = {
  args: { provider: "opencode" },
}
