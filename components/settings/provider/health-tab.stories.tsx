import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { HealthTab } from "./health-tab"

type HealthResult = {
  success: boolean
  latency?: number
  error?: string
  outcome?: "verified" | "failed" | "limited"
}

// Pure component: holds its own check-history in local state and calls the
// `onTestConnection` prop (an async function) when "Run check" is clicked.
// Default renders the empty/no-data state; the latency chart and timeline
// appear after a check resolves.
const meta = {
  title: "Settings/Provider/HealthTab",
  component: HealthTab,
  parameters: { layout: "padded" },
  args: {
    providerId: "openai",
    isTesting: false,
    onTestConnection: fn(
      async (): Promise<HealthResult> => ({
        success: true,
        latency: 142,
        outcome: "verified",
      })
    ),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HealthTab>
export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const Testing: Story = {
  args: { isTesting: true },
}

export const FailingProbe: Story = {
  args: {
    onTestConnection: fn(
      async (): Promise<HealthResult> => ({
        success: false,
        error: "401 Unauthorized — invalid API key",
        outcome: "failed",
      })
    ),
  },
}
