import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StyleSampleEditorDialog } from "./style-sample-editor-dialog"
import { makeStyleSample } from "@/lib/storybook/fixtures/twin"

// Pure props-only dialog. `sample = null` is add mode.
const meta = {
  title: "Twin/Persona/StyleSampleEditorDialog",
  component: StyleSampleEditorDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    sample: null,
    onSave: fn(async () => {}),
  },
} satisfies Meta<typeof StyleSampleEditorDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Add: Story = {}

export const Edit: Story = {
  args: {
    sample: makeStyleSample({ contextLabel: "Customer apology", tone: ["empathetic", "concise"] }),
  },
}
