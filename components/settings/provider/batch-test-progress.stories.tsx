import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { BatchTestProgress, TestResultsSummary } from "./batch-test-progress"

// Pure components. `BatchTestProgress` renders a progress bar + cancel button
// while a batch verification runs (returns null when `isRunning` is false).
// `TestResultsSummary` (a second named export, storied separately below)
// summarizes pass/fail counts.
const meta = {
  title: "Settings/Provider/BatchTestProgress",
  component: BatchTestProgress,
  parameters: { layout: "padded" },
  args: {
    isRunning: true,
    progress: 45,
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BatchTestProgress>
export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}

export const NearlyComplete: Story = {
  args: { progress: 92 },
}

export const CancelRequested: Story = {
  args: { progress: 60, cancelRequested: true },
}

// Returns null when not running.
export const NotRunning: Story = {
  args: { isRunning: false },
}

// --- TestResultsSummary (second export from this module) ---

type SummaryStory = StoryObj<typeof TestResultsSummary>

export const SummaryAllPassed: SummaryStory = {
  render: (args) => <TestResultsSummary {...args} />,
  args: { success: 5, failed: 0, total: 5, operationType: "verify-enabled" },
}

export const SummaryWithFailures: SummaryStory = {
  render: (args) => <TestResultsSummary {...args} />,
  args: {
    success: 3,
    failed: 2,
    total: 5,
    operationType: "verify-selected",
    completed: 5,
    expectedTotal: 5,
  },
}

export const SummaryRetryCanceled: SummaryStory = {
  render: (args) => <TestResultsSummary {...args} />,
  args: {
    success: 1,
    failed: 1,
    total: 2,
    operationType: "retry-failed",
    completed: 2,
    expectedTotal: 4,
    canceled: true,
  },
}
