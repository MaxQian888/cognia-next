import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PlaybookEditorDialog } from "./playbook-editor-dialog"
import { makePlaybook } from "@/lib/storybook/fixtures/twin"

// Pure props-only dialog. `playbook = null` is add mode.
const meta = {
  title: "Twin/Persona/PlaybookEditorDialog",
  component: PlaybookEditorDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    playbook: null,
    onSave: fn(async () => {}),
  },
} satisfies Meta<typeof PlaybookEditorDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Add: Story = {}

export const Edit: Story = {
  args: { playbook: makePlaybook({ title: "P1 Outage Response", confidence: 0.91 }) },
}
