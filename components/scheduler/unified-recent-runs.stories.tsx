import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { UnifiedRecentRuns } from "./unified-recent-runs"

// `UnifiedRecentRuns` fans recent execution rows in from five Dexie stores via
// the `useUnifiedRecentRuns` hook (`useLiveQuery`). It has no props to seed the
// data — in Storybook the live queries resolve against an empty IndexedDB, so
// these stories capture the loading → empty progression and the clickable vs
// read-only row affordance. (The hook degrades gracefully to an empty list;
// no Tauri/sidecar is involved.)
const meta = {
  title: "Scheduler/UnifiedRecentRuns",
  component: UnifiedRecentRuns,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UnifiedRecentRuns>

export default meta
type Story = StoryObj<typeof meta>

// Read-only: no `onSelectRun`, so rows render disabled (no hover affordance).
export const ReadOnly: Story = {
  args: {
    limit: 5,
  },
}

// Clickable: rows become buttons that emit the selected unified run.
export const Clickable: Story = {
  args: {
    limit: 5,
    onSelectRun: fn(),
  },
}

// A larger cap.
export const LargerLimit: Story = {
  args: {
    limit: 10,
    onSelectRun: fn(),
  },
}
