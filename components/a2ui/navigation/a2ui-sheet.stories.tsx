import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UISheet, type A2UISheetComponent } from "./a2ui-sheet"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { placeholderChild, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const sheet = (over: Partial<A2UISheetComponent> = {}): A2UISheetComponent => ({
  id: "sheet",
  component: "Sheet",
  trigger: "sheet-trigger",
  title: "Edit profile",
  description: "Update the details shown on your public card.",
  children: ["sheet-body"],
  ...over,
})

const renderChild = (id: string) =>
  placeholderChild(id, id === "sheet-trigger" ? "Open sheet" : "Form fields")

const meta = {
  title: "A2UI/Navigation/Sheet",
  component: A2UISheet,
  decorators: [withA2UISurface()],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UISheet>

export default meta
type Story = StoryObj<typeof meta>

export const ClosedWithTrigger: Story = {
  args: makeA2UIProps(sheet(), { renderChild }),
}

export const OpenRight: Story = {
  args: makeA2UIProps(sheet({ open: true, side: "right" }), { renderChild }),
}

export const OpenLeft: Story = {
  args: makeA2UIProps(sheet({ open: true, side: "left" }), { renderChild }),
}
