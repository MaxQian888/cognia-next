import type { Meta, StoryObj } from "@storybook/nextjs"

import { SiteAnalyticsPanel } from "./site-analytics-view"

const days = Array.from({ length: 14 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10)
  const requests = 12_000 + Math.round(Math.sin(index) * 4_000) + index * 300
  return { date, requests, errors: index === 9 ? 420 : 10 + index, subrequests: requests * 2 }
})

// Requests and errors are deliberately two single-series charts. They differ by
// orders of magnitude, so one axis flattens errors onto the baseline and a
// second invents a correlation that is not in the data.
const meta = {
  title: "Sites/SiteAnalyticsPanel",
  component: SiteAnalyticsPanel,
  args: {
    view: {
      worker: {
        points: days,
        totals: days.reduce(
          (acc, day) => ({
            date: "",
            requests: acc.requests + day.requests,
            errors: acc.errors + day.errors,
            subrequests: acc.subrequests + day.subrequests,
          }),
          { date: "", requests: 0, errors: 0, subrequests: 0 }
        ),
      },
      providerErrors: [],
      unrecognized: false,
    },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="@container/site-pane w-full max-w-4xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SiteAnalyticsPanel>

export default meta
type Story = StoryObj<typeof meta>

export const WorkerOnly: Story = {}

/** With a zone id and a hostname the query also returns page views and uniques. */
export const WithZoneMetrics: Story = {
  args: {
    view: {
      ...meta.args.view,
      web: {
        points: days.map((day) => ({
          date: day.date,
          requests: day.requests,
          pageViews: Math.round(day.requests * 0.7),
          bytes: day.requests * 4_200,
          uniques: Math.round(day.requests * 0.08),
        })),
        totals: {
          date: "",
          requests: 180_000,
          pageViews: 126_000,
          bytes: 756_000_000,
          uniques: 14_400,
        },
      },
    },
  },
}

/** GraphQL can return errors alongside partial data; both are shown. */
export const Partial: Story = {
  args: { view: { ...meta.args.view, providerErrors: ["rate limited"] } },
}

export const NoTraffic: Story = {
  args: {
    view: {
      worker: { points: [], totals: { date: "", requests: 0, errors: 0, subrequests: 0 } },
      providerErrors: [],
      unrecognized: false,
    },
  },
}
