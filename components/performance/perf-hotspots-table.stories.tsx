import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PerfHotspotsTable } from "./perf-hotspots-table"
import type { SpanSnapshot } from "@/lib/perf/backend/types"

const span = (name: string, over: Partial<SpanSnapshot>): SpanSnapshot => ({
  name,
  count: 100,
  errorCount: 0,
  totalMs: 1200,
  avgMs: 12,
  minMs: 1,
  maxMs: 90,
  p50Ms: 10,
  p95Ms: 45,
  lastTsMs: 0,
  buckets: [2, 8, 20, 35, 18, 9, 4, 1, 0, 0],
  ...over,
})

const spans: SpanSnapshot[] = [
  span("db.query.messages", { totalMs: 4200, count: 320, avgMs: 13, p95Ms: 60, maxMs: 210 }),
  span("vector.search", { totalMs: 2600, count: 48, avgMs: 54, p95Ms: 120, errorCount: 2 }),
  span("llm.generate", { totalMs: 1800, count: 12, avgMs: 150, p95Ms: 320, maxMs: 800 }),
  span("ipc.invoke", { totalMs: 640, count: 540, avgMs: 1.2, p95Ms: 4 }),
]

const meta = {
  title: "Performance/PerfHotspotsTable",
  component: PerfHotspotsTable,
  args: { spans },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PerfHotspotsTable>

export default meta
type Story = StoryObj<typeof meta>

export const WithSpans: Story = {}

export const Empty: Story = { args: { spans: [] } }
