import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CaseEditor } from "./case-editor"
import { makeCase } from "@/lib/storybook/fixtures/eval"

// Pure controlled form for one EvalCase. The reference section (expected
// output/tools/contains/context/toolArgs) lives in a <details>. Save is blocked
// on invalid JSON in expectedToolArgs.
const meta = {
  title: "Eval/CaseEditor",
  component: CaseEditor,
  parameters: { layout: "padded" },
  args: { onSave: fn(), onCancel: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CaseEditor>

export default meta
type Story = StoryObj<typeof meta>

export const New: Story = {}

export const Editing: Story = {
  args: {
    initial: makeCase({
      input: "Find the regression that broke the nightly CI build.",
      capability: "chat.tool-use",
      split: "test",
      tags: ["smoke", "tools"],
      notes: "Promoted from a real failing trace.",
      reference: {
        expectedTools: ["read_file", "run_command"],
        expectedContains: ["root cause", "fix"],
      },
    }),
  },
}
