import type { Meta, StoryObj } from "@storybook/nextjs"

import { ChartJsRichOutput } from "./chartjs-rich-output"

const data = {
  labels: ["Jan", "Feb", "Mar", "Apr", "May"],
  datasets: [
    {
      label: "Revenue",
      data: [12, 19, 14, 22, 28],
      borderColor: "#0ea5e9",
      backgroundColor: "rgba(14,165,233,0.4)",
    },
  ],
}

// Chart.js canvas renderer. Keep the dataset small so it paints instantly.
const meta = {
  title: "A2UI/RichOutput/ChartJs",
  component: ChartJsRichOutput,
  parameters: { layout: "centered" },
  args: { chartType: "bar", data },
  decorators: [
    (Story) => (
      <div className="h-[300px] w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChartJsRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Bar: Story = {}

export const Line: Story = { args: { chartType: "line" } }

export const Doughnut: Story = {
  args: {
    chartType: "doughnut",
    data: {
      labels: ["A", "B", "C"],
      datasets: [{ label: "Share", data: [5, 3, 2], backgroundColor: "#0ea5e9" }],
    },
  },
}
