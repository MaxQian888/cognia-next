import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileGhostAccept } from "./mobile-ghost-accept"

// Touch-friendly accept / dismiss controls for the composer ghost suggestion
// (mobile has no Tab/Esc keys).
const meta = {
  title: "Chat/Composer/MobileGhostAccept",
  component: MobileGhostAccept,
  parameters: { layout: "padded" },
  args: { visible: true, onAccept: fn(), onDismiss: fn() },
} satisfies Meta<typeof MobileGhostAccept>

export default meta
type Story = StoryObj<typeof meta>

// Accept (with label) + dismiss buttons.
export const Visible: Story = {}

// Not visible → renders nothing.
export const Hidden: Story = {
  args: { visible: false },
}
