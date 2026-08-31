import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetQuickMenu } from "./pet-quick-menu"

// Shared right-click quick menu for the widget. Every action is injected.
// Right-click the target box to open the menu.
const actions = {
  onFeed: fn(),
  onPlay: fn(),
  onPet: fn(),
  onTalk: fn(),
  onSleep: fn(),
  onClean: fn(),
  onTreat: fn(),
  onOpenConsole: fn(),
  onToggleDesktopPet: fn(),
  onMinimize: fn(),
  onOpenSettings: fn(),
}

const Target = () => (
  <div className="flex size-32 select-none items-center justify-center rounded-xl border bg-card text-sm text-muted-foreground">
    Right-click me
  </div>
)

const meta = {
  title: "Pet/QuickMenu",
  component: PetQuickMenu,
  parameters: { layout: "centered" },
  args: {
    actions,
    children: <Target />,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof PetQuickMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Widget: Story = {}

export const WidgetWithDesktopPet: Story = {
  args: { showDesktopPetItems: true, desktopPetOpen: false },
}

export const WidgetDesktopPetOpen: Story = {
  args: { showDesktopPetItems: true, desktopPetOpen: true },
}
