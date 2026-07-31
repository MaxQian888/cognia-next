import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConditionBuilder } from "./condition-builder"
import type { WorkflowConditionGroup } from "@/types/workflow/conditions"

// Controlled wrapper — the builder edits a WorkflowConditionGroup in place.
// Each row's left operand is a CodeMirror expression field (ExpressionField);
// with no editor store it renders without context-aware completions.
function Demo({ initial }: { initial?: WorkflowConditionGroup }) {
  const [group, setGroup] = React.useState<WorkflowConditionGroup | undefined>(initial)
  return (
    <div className="w-[420px]">
      <ConditionBuilder value={group} onChange={setGroup} idPrefix="story" />
    </div>
  )
}

const meta = {
  title: "Workflow/ConditionBuilder",
  component: ConditionBuilder,
  parameters: { layout: "centered" },
  // Default args satisfy the required props; the stories override `render`.
  args: { value: undefined, onChange: fn(), idPrefix: "story" },
} satisfies Meta<typeof ConditionBuilder>

export default meta
type Story = StoryObj<typeof meta>

// AND group with two comparisons across binary and unary operators.
export const AllOf: Story = {
  render: () => (
    <Demo
      initial={{
        combinator: "all",
        conditions: [
          { left: "{{ $json.status }}", operator: "eq", right: "open" },
          { left: "{{ $json.assignee }}", operator: "isNotEmpty" },
        ],
      }}
    />
  ),
}

// OR group using a range operator (inRange uses right + rightUpper).
export const AnyOfWithRange: Story = {
  render: () => (
    <Demo
      initial={{
        combinator: "any",
        conditions: [
          { left: "{{ $json.priority }}", operator: "inRange", right: "1", rightUpper: "3" },
          {
            left: "{{ $json.title }}",
            operator: "contains",
            right: "urgent",
            caseSensitive: false,
          },
        ],
      }}
    />
  ),
}

// Undefined value — the empty builder with just an "add condition" affordance.
export const Empty: Story = {
  render: () => <Demo initial={undefined} />,
}
