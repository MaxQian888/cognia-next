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
