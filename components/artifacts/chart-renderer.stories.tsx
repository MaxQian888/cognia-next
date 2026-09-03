import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ChartRenderer } from "./chart-renderer"
import type { ChartDataPoint } from "@/types"

const series: ChartDataPoint[] = [
  { name: "Mon", value: 12, errors: 1 },
  { name: "Tue", value: 19, errors: 0 },
  { name: "Wed", value: 7, errors: 3 },
  { name: "Thu", value: 22, errors: 1 },
  { name: "Fri", value: 16, errors: 0 },
]

const meta = {
  title: "Artifacts/ChartRenderer",
  component: ChartRenderer,
  args: { content: "", chartData: series },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ChartRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Line: Story = { args: { chartType: "line" } }
export const Bar: Story = { args: { chartType: "bar" } }
export const Area: Story = { args: { chartType: "area" } }
export const Pie: Story = { args: { chartType: "pie" } }

export const Empty: Story = { args: { chartData: [] } }

// Unparseable content (and no chartData) → destructive alert.
export const ParseError: Story = {
  args: { chartData: undefined, content: "{ not valid json" },
}

// The regression this whole change exists for: before the contract fix, a pie
// whose numeric key was not literally `value` rendered completely blank.
export const PieByNonValueKey: Story = {
  args: {
    chartType: "pie",
    chartData: undefined,
    content: JSON.stringify(
      {
        type: "pie",
        data: [
          { name: "Chrome", share: 62 },
          { name: "Safari", share: 21 },
          { name: "Edge", share: 11 },
          { name: "Firefox", share: 6 },
        ],
      },
      null,
      2
    ),
  },
}

// Best-effort render plus the notice: an unsupported type, a series that only
// appears after the first row, a row with no name, and a non-numeric value.
export const DegradedWithNotice: Story = {
  args: {
    chartType: undefined,
    chartData: undefined,
    content: JSON.stringify(
      {
        type: "histogram",
        data: [
          { name: "Jan", revenue: 10 },
          { name: "Feb", revenue: 12, cost: 4 },
          { name: "", revenue: null },
        ],
      },
      null,
      2
    ),
  },
}
