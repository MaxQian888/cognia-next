import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowVariablesEditor } from "./workflow-variables-editor"

// Key→value editor for author-time workflow variables (`{{ $vars.KEY }}`).
// Pure value/onChange — the controlled wrapper round-trips edits so add/remove
// and inline key validation are exercisable.
function Controlled({ initial = {} }: { initial?: Record<string, string> }) {
  const [value, setValue] = React.useState<Record<string, string>>(initial)
  return (
    <div className="w-[360px]">
      <WorkflowVariablesEditor value={value} onChange={setValue} />
    </div>
  )
}

const meta = {
  title: "Workflow/Editor/Settings/WorkflowVariablesEditor",
  component: WorkflowVariablesEditor,
  parameters: { layout: "padded" },
  args: { value: {}, onChange: fn() },
} satisfies Meta<typeof WorkflowVariablesEditor>

export default meta
type Story = StoryObj<typeof meta>

// A few defined variables.
export const WithVariables: Story = {
  render: () => <Controlled initial={{ region: "us-east-1", retries: "3", channel: "#alerts" }} />,
}

// Empty — just the "add variable" affordance.
export const Empty: Story = {
  render: () => <Controlled />,
}
