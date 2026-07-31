import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AutoComposeClarifyStep } from "./auto-compose-clarify-step"

const questions = [
  "Which repositories should the team have access to?",
  "Is there a deadline or token budget to respect?",
]

const meta = {
  title: "Agent/Workspace/AutoCompose/ClarifyStep",
  component: AutoComposeClarifyStep,
  args: {
    questions,
    answers: ["", ""],
    onAnswerChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoComposeClarifyStep>

export default meta
type Story = StoryObj<typeof meta>

export const Unanswered: Story = {}

export const PartiallyAnswered: Story = {
  args: { answers: ["The cognia-next monorepo", ""] },
}
