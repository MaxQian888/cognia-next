import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, userEvent, within } from "storybook/test"

import { StandaloneSearchPanel } from "./standalone-search-panel"
import type { StandaloneSearchAnswer } from "@/lib/search/standalone-answer"

const fakeAnswer: StandaloneSearchAnswer = {
  query: "What is a sliding-window rate limiter?",
  answer:
    "A sliding-window rate limiter caps requests over a moving time window by tracking recent " +
    "timestamps and rejecting calls once the count within the window exceeds the limit [1][2].",
  provider: "tavily",
  sources: [
    {
      title: "Rate limiting algorithms",
      url: "https://example.com/rate-limiting",
      content: "Overview of token bucket and sliding window.",
      score: 0.92,
    },
    {
      title: "Sliding window counters",
      url: "https://example.com/sliding-window",
      content: "Implementation notes.",
      score: 0.81,
    },
  ],
}

// Standalone (BYOK) web-search surface. Purely presentational over
// `useStandaloneSearch`; the `runImpl` seam lets stories drive the result state
// without network access.
const meta = {
  title: "Search/StandaloneSearchPanel",
  component: StandaloneSearchPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StandaloneSearchPanel>

export default meta
type Story = StoryObj<typeof meta>

// Default idle state — the prompt hint before any query runs.
export const Idle: Story = {}

export const AnsweredWithSources: Story = {
  args: { searchOptions: { runImpl: async () => fakeAnswer } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByTestId("standalone-search-input"),
      "What is a sliding-window rate limiter?"
    )
    await userEvent.click(await canvas.findByTestId("standalone-search-run"))
    await expect(await canvas.findByTestId("standalone-search-result")).toBeVisible()
  },
}
