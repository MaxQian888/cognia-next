import type { Meta, StoryObj } from "@storybook/nextjs"

import { ThemePreview } from "./theme-preview"
import { DEFAULT_FALLBACKS } from "@/lib/appearance"

// Tiny mock chat surface that previews a `ThemeColors` palette without applying
// it to the document. Colors are passed in directly; missing tokens fall back
// to the supplied full palette.
const meta = {
  title: "Settings/Appearance/ThemePreview",
  component: ThemePreview,
  parameters: { layout: "padded" },
  args: { colors: {}, fallback: DEFAULT_FALLBACKS.light },
} satisfies Meta<typeof ThemePreview>

export default meta
type Story = StoryObj<typeof meta>

// Light fallback palette, no overrides.
export const Light: Story = {
  args: { colors: {}, fallback: DEFAULT_FALLBACKS.light },
}

// Dark fallback palette.
export const Dark: Story = {
  args: { colors: {}, fallback: DEFAULT_FALLBACKS.dark },
}

// A custom primary/accent layered over the light fallback, with custom copy.
export const CustomOverrides: Story = {
  args: {
    fallback: DEFAULT_FALLBACKS.light,
    colors: { primary: "#7c4dff", accent: "#10b981", background: "#fdf4ff" },
    assistantText: "Here is your themed assistant reply.",
    userText: "Looks great!",
  },
}
