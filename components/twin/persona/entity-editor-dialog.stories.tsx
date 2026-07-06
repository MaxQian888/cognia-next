import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EntityEditorDialog } from "./entity-editor-dialog"
import { makeEntity } from "@/lib/storybook/fixtures/twin"

// Pure props-only dialog. `entity = null` is add mode; a row puts it in edit
// mode. `onSave` is a spy.
const meta = {
  title: "Twin/Persona/EntityEditorDialog",
  component: EntityEditorDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    entity: null,
    onSave: fn(async () => {}),
  },
} satisfies Meta<typeof EntityEditorDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Add: Story = {}

export const Edit: Story = {
  args: { entity: makeEntity({ name: "Dana Lee", role: "person", relation: "Manager" }) },
}

export const Saving: Story = {
  args: { entity: makeEntity(), busy: true },
}
