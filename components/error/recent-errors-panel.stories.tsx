import type { Meta, StoryObj } from "@storybook/nextjs"

import { RecentErrorsPanel, type RecentErrorsCopy } from "./recent-errors-panel"
import { clearRecentErrorLogs, recordRecentErrorLog } from "@cognia/logging/recent-errors"

const copy: RecentErrorsCopy = {
  title: "Recent errors",
  cascadeHint: "Several errors occurred together — this may be a cascading failure.",
}

const NOW = Date.now()

// Reads the in-memory recent-error stream. Renders nothing when empty, so the
// populated story seeds a few entries (close together → cascade hint shows).
const meta = {
  title: "Error/RecentErrorsPanel",
  component: RecentErrorsPanel,
  args: { copy },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RecentErrorsPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Cascading: Story = {
  beforeEach: () => {
    clearRecentErrorLogs()
    for (let i = 0; i < 4; i++) {
      recordRecentErrorLog({
        id: `err_${i}`,
        timestamp: new Date(NOW - i * 800).toISOString(),
        level: "error",
        message: `Failed to load artifact chunk #${i}`,
        module: "artifacts",
      })
    }
  },
}

// Empty stream → the panel renders nothing.
export const Empty: Story = {
  beforeEach: () => {
    clearRecentErrorLogs()
  },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <RecentErrorsPanel {...args} />
    </div>
  ),
}
