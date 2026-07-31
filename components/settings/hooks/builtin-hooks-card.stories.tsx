import type { Meta, StoryObj } from "@storybook/nextjs"

import { BuiltinHooksCard } from "./builtin-hooks-card"

// Toggles for the product-bundled built-in hooks. Reads + writes user settings
// directly via the Tauri-backed helpers; in the browser the read resolves
// empty, so every built-in renders at its default enabled state. No props.
const meta = {
  title: "Settings/Hooks/BuiltinHooksCard",
  component: BuiltinHooksCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof BuiltinHooksCard>

export default meta
type Story = StoryObj<typeof meta>

// Default overrides (empty) → each built-in hook shows its shipped default.
export const Default: Story = {}
