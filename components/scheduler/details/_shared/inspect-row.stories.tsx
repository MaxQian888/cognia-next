import type { Meta, StoryObj } from "@storybook/nextjs"

import { InspectRow } from "./inspect-row"
import { Badge } from "@/components/ui/badge"

// `InspectRow` is a pure label/value primitive. With only `value` it renders a
// two-column form; supplying `compareValue` switches it to the three-column
// platform-vs-metadata comparison used by the system-task inspect sheet, which
// highlights mismatched values in amber. Empty string values render as "-".
const meta = {
  title: "Scheduler/Details/InspectRow",
  component: InspectRow,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[420px] rounded-md border bg-card p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InspectRow>

export default meta
type Story = StoryObj<typeof meta>

// Simple two-column label + value.
export const TwoColumn: Story = {
  args: {
    label: "Cron",
    value: "0 9 * * 1-5",
  },
}

// Empty string value falls back to a "-" placeholder.
export const EmptyValue: Story = {
  args: {
    label: "Destination",
    value: "",
  },
}

// `value` accepts a ReactNode — here a status badge.
export const ReactNodeValue: Story = {
  args: {
    label: "Status",
    value: (
      <Badge variant="outline" className="text-[10px] border-green-500/30 text-green-600">
        active
      </Badge>
    ),
  },
}

// Three-column comparison where both sides agree → no highlight.
export const ComparisonMatch: Story = {
  args: {
    label: "Schedule",
    value: "0 9 * * *",
    compareValue: "0 9 * * *",
  },
}

// Three-column comparison where the two sides differ → amber highlight.
export const ComparisonMismatch: Story = {
  args: {
    label: "Run level",
    value: "user",
    compareValue: "admin",
  },
}
