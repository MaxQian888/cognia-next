import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetNameEditor } from "./pet-name-editor"

// Inline rename affordance: name + pencil; the pencil swaps in an input
// (Enter / blur saves, Escape cancels). Click the pencil to enter edit mode.
const meta = {
  title: "Pet/NameEditor",
  component: PetNameEditor,
  parameters: { layout: "centered" },
  args: { name: "Boba", onRename: fn() },
} satisfies Meta<typeof PetNameEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const LongName: Story = {
  args: { name: "Sir Reginald Whiskersworth III" },
}

export const LargeHeading: Story = {
  args: { nameClassName: "text-2xl" },
}
