import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PerfGraphCard } from "./perf-graph-card"

const wave = (n: number, base: number, amp: number) =>
  Array.from({ length: n }, (_, i) => base + Math.round(amp * (0.5 + 0.5 * Math.sin(i / 3))))

const meta = {
  title: "Performance/PerfGraphCard",
  component: PerfGraphCard,
  args: {
    title: "CPU",
    current: "42.3%",
    points: wave(40, 20, 50),
    color: "#22c55e",
    className: "w-80",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfGraphCard>

export default meta
type Story = StoryObj<typeof meta>

export const CpuPercent: Story = {
  args: { max: 100, threshold: 80 },
}

export const MemoryAuto: Story = {
  args: {
    title: "Memory",
    current: "1.5 GB",
    color: "#6366f1",
    points: wave(40, 800, 900),
    max: undefined,
    subtitle: "Peak 2.1 GB",
  },
}

export const Flatline: Story = {
  args: { title: "Tasks", current: "3", color: "#f59e0b", points: Array(40).fill(3), max: 10 },
}
