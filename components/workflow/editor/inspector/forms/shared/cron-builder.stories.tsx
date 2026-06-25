import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CronBuilder } from "./cron-builder"

// Controlled wrapper — the builder is value/onChange driven and previews the
// next fire times against the supplied timezone.
function Demo({ initial, timezone }: { initial: string; timezone?: string }) {
  const [expr, setExpr] = React.useState(initial)
  return (
    <div className="w-80">
      <CronBuilder id="cron" value={expr} onChange={setExpr} timezone={timezone} />
    </div>
  )
}

const meta = {
  title: "Workflow/CronBuilder",
  component: CronBuilder,
  parameters: { layout: "centered" },
  // Default args satisfy the required props; the stories override `render`.
  args: { id: "cron", value: "0 9 * * 1-5", onChange: fn() },
} satisfies Meta<typeof CronBuilder>

export default meta
type Story = StoryObj<typeof meta>

// Weekdays at 09:00, previewed in a US timezone.
export const Weekdays9am: Story = {
  render: () => <Demo initial="0 9 * * 1-5" timezone="America/New_York" />,
}

// Every 15 minutes.
export const EveryFifteenMinutes: Story = {
  render: () => <Demo initial="*/15 * * * *" timezone="UTC" />,
}

// An invalid expression — exercises the validation error preview.
export const Invalid: Story = {
  render: () => <Demo initial="not a cron" timezone="UTC" />,
}
