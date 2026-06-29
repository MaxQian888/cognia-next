import type { Meta, StoryObj } from "@storybook/nextjs"
import * as React from "react"

import { A2UIChart } from "./a2ui-chart"
import type { A2UIChartComponent, A2UIChartDataPoint } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const SERIES: A2UIChartDataPoint[] = [
  { name: "Jan", value: 4200, target: 4000 },
  { name: "Feb", value: 4810, target: 4300 },
  { name: "Mar", value: 5300, target: 4800 },
  { name: "Apr", value: 4980, target: 5200 },
  { name: "May", value: 6120, target: 5600 },
  { name: "Jun", value: 6890, target: 6000 },
]

const SHARE: A2UIChartDataPoint[] = [
  { name: "Desktop", value: 540 },
  { name: "Mobile", value: 320 },
  { name: "Tablet", value: 140 },
]

const chart = (over: Partial<A2UIChartComponent> = {}): A2UIChartComponent => ({
  id: "chart",
  component: "Chart",
  chartType: "line",
  data: SERIES,
  title: "Monthly revenue",
  ...over,
})

const meta = {
  title: "A2UI/Data/Chart",
  component: A2UIChart,
  decorators: [
    withA2UISurface(),
    (Story: React.ComponentType) => <div className="w-[520px] max-w-full">{<Story />}</div>,
  ],
  parameters: { layout: "centered" },
} satisfies Meta<typeof A2UIChart>

export default meta
type Story = StoryObj<typeof meta>

export const Line: Story = { args: makeA2UIProps(chart({ chartType: "line" })) }

export const MultiSeriesBar: Story = {
  args: makeA2UIProps(
    chart({ chartType: "bar", yKeys: ["value", "target"], title: "Revenue vs target" })
  ),
}

export const Area: Story = { args: makeA2UIProps(chart({ chartType: "area" })) }

export const Pie: Story = {
  args: makeA2UIProps(chart({ chartType: "pie", data: SHARE, title: "Traffic by device" })),
}

export const Donut: Story = {
  args: makeA2UIProps(chart({ chartType: "donut", data: SHARE, title: "Traffic by device" })),
}
