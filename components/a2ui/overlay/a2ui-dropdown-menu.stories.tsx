import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIDropdownMenu, type A2UIDropdownMenuComponent } from "./a2ui-dropdown-menu"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild } from "@/lib/storybook/fixtures/a2ui-surface"

const dropdown = (over: Partial<A2UIDropdownMenuComponent> = {}): A2UIDropdownMenuComponent => ({
  id: "dropdown",
  component: "DropdownMenu",
  trigger: "dropdown-trigger",
  label: "Actions",
  items: [
    { id: "copy", label: "Copy", action: "copy", icon: "Copy" },
    { id: "edit", label: "Edit", action: "edit", icon: "Pencil" },
    { id: "sep", label: "", separator: true },
    { id: "delete", label: "Delete", action: "delete", icon: "Trash2", danger: true },
  ],
  ...over,
})

const renderChild = (id: string) => placeholderChild(id, "Open menu")

const meta = {
  title: "A2UI/Overlay/DropdownMenu",
  component: A2UIDropdownMenu,
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIDropdownMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: makeA2UIProps(dropdown(), { renderChild }),
}

export const AlignEnd: Story = {
  args: makeA2UIProps(dropdown({ align: "end" }), { renderChild }),
}

export const WithDisabledItem: Story = {
  args: makeA2UIProps(
    dropdown({
      items: [
        { id: "rename", label: "Rename", action: "rename" },
        { id: "archive", label: "Archive (unavailable)", action: "archive", disabled: true },
      ],
    }),
    { renderChild }
  ),
}
