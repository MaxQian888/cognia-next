import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { EditableField } from "./editable-field"

const meta = {
  title: "Agent/Workspace/EditableField",
  component: EditableField,
  args: {
    value: "Bug-fix squad",
    onSave: fn(),
    editTooltipKey: "editAriaLabel",
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EditableField>

export default meta
type Story = StoryObj<typeof meta>

// Display mode; click the value to switch to inline editing.
export const Input: Story = {}

export const Textarea: Story = {
  args: { variant: "textarea", value: "Reproduce, fix, and ship the reducer regression.", rows: 3 },
}

// Empty value falls back to the empty-hint placeholder.
export const Empty: Story = {
  args: { value: "", emptyHintKey: "editAriaLabel" },
}

export const Disabled: Story = {
  args: { disabled: true },
}
