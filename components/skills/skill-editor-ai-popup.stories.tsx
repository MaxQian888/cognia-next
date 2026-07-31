import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SkillEditorAiPopup } from "./skill-editor-ai-popup"
import { makeValidationError } from "@/lib/storybook/fixtures/skills"

const SUGGESTION = `# Release Notes Writer

Generate concise, customer-facing release notes from merged pull requests.

## Steps
1. Group merged PRs by area (Features, Fixes, Chores).
2. Write one user-benefit bullet per change.
3. Lead with the highest-impact item.
`

// Pure props-only modal — the AI intents call `onAiAssist`, which resolves to a
// markdown suggestion rendered in the diff card. `fn()` spies record the calls.
const meta = {
  title: "Skills/SkillEditorAiPopup",
  component: SkillEditorAiPopup,
  parameters: { layout: "centered" },
  args: {
    current: {
      name: "Release Notes Writer",
      description: "Drafts release notes from merged PRs.",
      content: "# Release Notes\n\nSummarize PRs.\n",
    },
    validationErrors: [],
    onClose: fn(),
    onAccept: fn(),
    onAiAssist: fn(async (): Promise<string | null> => SUGGESTION),
  },
} satisfies Meta<typeof SkillEditorAiPopup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithValidationErrors: Story = {
  args: {
    validationErrors: [
      makeValidationError({ code: "missing-content", field: undefined, message: "Body is empty." }),
    ],
  },
}

export const AssistUnavailable: Story = {
  args: { onAiAssist: fn(async () => null) },
}
