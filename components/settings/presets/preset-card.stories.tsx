import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PresetCard } from "./preset-card"
import { makePreset } from "@/lib/storybook/fixtures/settings-presets"

// One row in the system-prompt preset list: avatar glyph, name/description,
// category badge, and edit/duplicate/delete/default/favorite actions. Pure
// props (delete is gated behind an AlertDialog confirm).
const meta = {
  title: "Settings/Presets/PresetCard",
  component: PresetCard,
  parameters: { layout: "padded" },
  args: {
    preset: makePreset(),
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onToggleDefault: fn(),
    onToggleFavorite: fn(),
  },
} satisfies Meta<typeof PresetCard>

export default meta
type Story = StoryObj<typeof meta>

// Standard editable preset.
export const Default: Story = {}

// Default + favorite flags set → both badges render.
export const DefaultAndFavorite: Story = {
  args: { preset: makePreset({ isDefault: true, isFavorite: true }) },
}

// Built-in preset (read-only — duplicate offered instead of edit).
export const BuiltIn: Story = {
  args: { preset: makePreset({ isBuiltIn: true, name: "Cognia default" }) },
}

// Multi-select mode: leading checkbox bound to `selected`.
export const Selectable: Story = {
  args: { selected: true, onSelectToggle: fn() },
}

// Reorder mode: drag handle visible.
export const Reorderable: Story = {
  args: { reorderable: true },
}
