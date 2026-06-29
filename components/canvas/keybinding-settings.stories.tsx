import type { Meta, StoryObj } from "@storybook/nextjs"

import { KeybindingSettings } from "./keybinding-settings"
import { Button } from "@/components/ui/button"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"

// KeybindingSettings renders a trigger button that opens a Dialog for editing
// Canvas keyboard shortcuts (search, per-action rebind, conflict warnings,
// import/export, reset). Bindings come from `useKeybindingStore`, which is
// reset to its defaults between stories. Click the trigger to open the editor.
const meta = {
  title: "Canvas/KeybindingSettings",
  component: KeybindingSettings,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useKeybindingStore)
  },
} satisfies Meta<typeof KeybindingSettings>

export default meta
type Story = StoryObj<typeof meta>

// Default ghost trigger button.
export const Default: Story = {}

// A custom trigger node passed via the `trigger` prop.
export const CustomTrigger: Story = {
  args: {
    trigger: <Button variant="outline">Edit canvas shortcuts</Button>,
  },
}
