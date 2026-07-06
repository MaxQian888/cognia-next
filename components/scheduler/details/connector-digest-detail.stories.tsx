import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConnectorDigestDetail } from "./connector-digest-detail"

// `ConnectorDigestDetail` loads the digest task by id from `schedulerDb` and
// surfaces its adapter/conversation/character payload alongside recent fires.
// Without a seeded scheduler DB the lookup resolves to `null`, so the panel
// renders its "task not found" fallback — the state shown when a digest task
// referenced by the URL no longer exists.
const meta = {
  title: "Scheduler/Details/ConnectorDigestDetail",
  component: ConnectorDigestDetail,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectRun: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl border rounded-md bg-card">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConnectorDigestDetail>

export default meta
type Story = StoryObj<typeof meta>

// Task id with no backing row → "not found" fallback.
export const NotFound: Story = {
  args: {
    taskId: "connector-digest-missing",
  },
}
