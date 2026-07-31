import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginAvatar } from "./plugin-avatar"

const IMG =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' rx='8' fill='#0ea5e9'/></svg>"
  )

const meta = {
  title: "Plugins/PluginAvatar",
  component: PluginAvatar,
  args: { name: "GitHub Delivery", size: 40 },
} satisfies Meta<typeof PluginAvatar>

export default meta
type Story = StoryObj<typeof meta>

// 1. image icon  2. Lucide-name icon  3. deterministic initial fallback.
export const ImageIcon: Story = { args: { icon: IMG } }

export const LucideIcon: Story = { args: { icon: "puzzle" } }

export const InitialFallback: Story = { args: { icon: undefined, seed: "github-delivery" } }

export const Palette: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"].map((seed) => (
        <PluginAvatar key={seed} name={seed} seed={seed} size={40} />
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-2">
      {[16, 20, 28, 40, 56].map((size) => (
        <PluginAvatar key={size} name="Cognia" seed="cognia" size={size} />
      ))}
    </div>
  ),
}
