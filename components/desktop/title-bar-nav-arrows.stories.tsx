import type { Meta, StoryObj } from "@storybook/nextjs"

import { TitleBarNavArrows } from "./title-bar-nav-arrows"

// Back / forward navigation arrows for the desktop title bar. Disabled state is
// driven by the in-memory nav history (Next exposes no `canGoBack`); fresh in
// isolation, both arrows render disabled.
const meta = {
  title: "Desktop/TitleBarNavArrows",
  component: TitleBarNavArrows,
  parameters: { layout: "centered" },
} satisfies Meta<typeof TitleBarNavArrows>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
