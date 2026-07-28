import type { Meta, StoryObj } from "@storybook/nextjs"

import { ShellLayoutCustomizer } from "./shell-layout-customizer"

// All three chrome surfaces — nav rail, top bar, bottom bar — behind one tab
// strip. Each story opens on a different tab so the two bar editors are
// reachable without a click.
const meta = {
  title: "Shell/ShellLayoutCustomizer",
  component: ShellLayoutCustomizer,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShellLayoutCustomizer>

export default meta
type Story = StoryObj<typeof meta>

export const Sidebar: Story = { args: { defaultSurface: "sidebar" } }
export const TopBar: Story = { args: { defaultSurface: "title" } }
export const BottomBar: Story = { args: { defaultSurface: "status" } }
