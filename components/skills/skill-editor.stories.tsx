import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillEditor } from "./skill-editor"
import { makeSkill } from "@/lib/storybook/fixtures/skills"

// Pure props-only form. `onSave`/`onCancel`/`onAiAssist` are spies; the form
// validates locally as you type.
const meta = {
  title: "Skills/SkillEditor",
  component: SkillEditor,
  parameters: { layout: "fullscreen" },
  args: {
    mode: "create",
    onCancel: fn(),
    onSave: fn(async () => {}),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkillEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Create: Story = {}

export const Edit: Story = {
  args: {
    mode: "edit",
    initial: makeSkill({ name: "Release Notes Writer" }),
  },
}

export const EditWithAiAssist: Story = {
  args: {
    mode: "edit",
    initial: makeSkill({ name: "Release Notes Writer" }),
    onAiAssist: fn(async () => "# Improved\n\nA tighter skill body.\n"),
  },
}
