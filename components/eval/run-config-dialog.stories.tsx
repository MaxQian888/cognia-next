import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RunConfigDialog } from "./run-config-dialog"

// Build an EvalRunConfig (target matrix × scorer subset × k × case subset).
// `appSettings === null` falls back to a default model; when target option
// lists are empty each ref field degrades to a free-text input.
const meta = {
  title: "Eval/RunConfigDialog",
  component: RunConfigDialog,
  parameters: { layout: "padded" },
  args: { datasetId: "ds-1", appSettings: null, onClose: fn(), onComplete: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RunConfigDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Populated option lists turn the ref fields into dropdowns.
export const WithTargetOptions: Story = {
  args: {
    options: {
      models: ["claude-opus-4-8", "claude-sonnet-4", "gpt-4o"],
      teams: [{ id: "team-1", name: "Research squad" }],
      workflows: [{ id: "wf-1", name: "Triage pipeline" }],
      characters: [{ id: "char-1", name: "Analyst" }],
    },
  },
}
