import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WallpaperCard } from "./wallpaper-card"
import type { Wallpaper } from "@/types/appearance"

// A single gallery tile that resolves its `Wallpaper.source` to a CSS
// background. Gradient + color sources resolve synchronously (no IndexedDB),
// so they render fully in Storybook. `active` draws the selected ring;
// `onDelete` (when provided, non-builtin) shows a delete affordance.
const gradient: Wallpaper = {
  id: "wp-gradient",
  name: "Sunset",
  kind: "gradient",
  source: { kind: "gradient", css: "linear-gradient(135deg, #ff7e5f 0%, #feb47b 100%)" },
  builtin: false,
  createdAt: Date.now(),
}

const solid: Wallpaper = {
  id: "wp-color",
  name: "Slate",
  kind: "color",
  source: { kind: "color", value: "#1e293b" },
  builtin: true,
  createdAt: Date.now(),
}

const meta = {
  title: "Settings/Appearance/WallpaperCard",
  component: WallpaperCard,
  parameters: { layout: "centered" },
  args: { wallpaper: gradient, active: false, onActivate: fn(), onDelete: fn() },
} satisfies Meta<typeof WallpaperCard>

export default meta
type Story = StoryObj<typeof meta>

// Inactive gradient tile with a delete button.
export const Gradient: Story = {
  args: { wallpaper: gradient, active: false },
}

// Active solid-color tile (built-in → no delete).
export const ActiveSolid: Story = {
  args: { wallpaper: solid, active: true, onDelete: undefined },
}
