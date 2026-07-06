import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { GoalPayloadEditor } from "./goal-payload-editor"
import type { GoalDraft } from "./types"

// Structured editor for `goal` tasks (ADR-0019). The draft holds the objective
// plus optional character binding and execution limits.
const meta = {
  title: "Scheduler/PayloadEditors/GoalPayloadEditor",
  component: GoalPayloadEditor,
  parameters: { layout: "padded" },
  args: {
    onDraftChange: fn(),
    testId: "goal-payload-editor",
  },
} satisfies Meta<typeof GoalPayloadEditor>

export default meta
type Story = StoryObj<typeof meta>

const EMPTY: GoalDraft = { objective: "" }

const FILLED: GoalDraft = {
  objective: "Triage the overnight error reports and open follow-up issues for any regression.",
  characterId: "char-ops-bot",
  maxTurns: 25,
  maxTokens: 200000,
  timeoutMinutes: 30,
}

// Blank objective — required-field asterisk visible, no values entered.
export const EmptyDraft: Story = {
  args: { draft: EMPTY },
}

// Fully-populated goal with character + all three execution limits.
export const FilledDraft: Story = {
  args: { draft: FILLED },
}

// Submit attempted with a blank objective → inline validation error.
export const WithError: Story = {
  args: {
    draft: EMPTY,
    errors: { objective: "objectiveRequired" },
  },
}

// Disabled (read-only).
export const Disabled: Story = {
  args: { draft: FILLED, disabled: true },
}
