import type { Meta, StoryObj } from "@storybook/nextjs"

import { SiteLogTable } from "./site-log-table"
import type { SiteLogEntry } from "@/lib/sites/cloudflare/observability-parse"

const NOW = 1_756_000_000_000

function entry(index: number, over: Partial<SiteLogEntry> = {}): SiteLogEntry {
  return {
    id: `e${index}`,
    timestamp: NOW - index * 4_000,
    level: index % 7 === 0 ? "error" : index % 3 === 0 ? "warn" : "info",
    message: index % 7 === 0 ? "Uncaught TypeError: r.get is not a function" : "GET /docs 200",
    requestMethod: "GET",
    requestUrl: "https://docs.cognia.dev/docs",
    statusCode: index % 7 === 0 ? 500 : 200,
    durationMs: 12 + index,
    raw: { $metadata: { level: "info" }, outcome: "ok" },
    ...over,
  }
}

// Cloudflare Worker logs as rows. Before this they were rendered with a JSON
// tree — honest, and unusable for scanning a window for the request that broke.
const meta = {
  title: "Sites/SiteLogTable",
  component: SiteLogTable,
  args: {
    view: {
      entries: Array.from({ length: 40 }, (_, index) => entry(index)),
      unparsed: 0,
      unrecognized: false,
    },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-4xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteLogTable>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Quiet: Story = {
  args: { view: { entries: [], unparsed: 0, unrecognized: false } },
}

/** Rows are counted, never dropped: a partial read must not look quiet. */
export const PartiallyUnreadable: Story = {
  args: {
    view: {
      entries: [entry(0), entry(1)],
      unparsed: 6,
      unrecognized: false,
    },
  },
}
