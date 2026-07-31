import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DurationField } from "./duration-field"

// Controlled wrapper — the field is value/onChange driven.
function Demo({ initial }: { initial: number }) {
  const [ms, setMs] = React.useState(initial)
  return (
    <div className="w-72 space-y-2">
      <DurationField id="wait-duration" value={ms} onChange={setMs} />
      <p className="text-xs text-muted-foreground tabular-nums">{ms} ms</p>
    </div>
  )
}

const meta = {
  title: "Workflow/DurationField",
  component: DurationField,
  parameters: { layout: "centered" },
  // Default args satisfy the required props; the stories override `render`.
  args: { id: "wait-duration", value: 300_000, onChange: fn() },
} satisfies Meta<typeof DurationField>

export default meta
type Story = StoryObj<typeof meta>

// Five minutes — normalizes to a minutes unit.
export const Minutes: Story = {
  render: () => <Demo initial={300_000} />,
}

// Ninety seconds.
export const Seconds: Story = {
  render: () => <Demo initial={90_000} />,
}

// Two hours.
export const Hours: Story = {
  render: () => <Demo initial={7_200_000} />,
}
