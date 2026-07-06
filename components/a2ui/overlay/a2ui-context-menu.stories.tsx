import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIContextMenu, type A2UIContextMenuComponent } from "./a2ui-context-menu"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const contextMenu = (over: Partial<A2UIContextMenuComponent> = {}): A2UIContextMenuComponent => ({
  id: "context-menu",
  component: "ContextMenu",
  trigger: "context-target",
  label: "Row actions",
  items: [
    { id: "copy", label: "Copy", action: "copy", icon: "Copy" },
    { id: "duplicate", label: "Duplicate", action: "duplicate", icon: "CopyPlus" },
    { id: "sep", label: "", separator: true },
    { id: "delete", label: "Delete", action: "delete", icon: "Trash2", danger: true },
  ],
  ...over,
})

const renderChild = (id: string) => placeholderChild(id, "Right-click this area")

const meta = {
  title: "A2UI/Overlay/ContextMenu",
  component: A2UIContextMenu,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIContextMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(contextMenu(), { renderChild }),
}

export const WithoutLabel: Story = {
  args: makeA2UIProps(contextMenu({ label: undefined }), { renderChild }),
}
