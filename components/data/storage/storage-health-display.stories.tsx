import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StorageHealthDisplay } from "./storage-health-display"
import type { StorageHealth } from "@/lib/storage"

const formatBytes = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`

// Pure props — status badge + issues + recommendations. `health: null` renders
// nothing.
const meta = {
  title: "Data/StorageHealthDisplay",
  component: StorageHealthDisplay,
  args: { formatBytes, onActionClick: fn() },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StorageHealthDisplay>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {
  args: {
    health: { status: "healthy", usagePercent: 18.4, issues: [], recommendations: [] },
  },
}

export const Warning: Story = {
  args: {
    health: {
      status: "warning",
      usagePercent: 82.1,
      issues: [
        {
          severity: "medium",
          message: "Storage is 82.1% full",
          suggestedAction: "Clear old chat history to free space.",
        },
      ],
      recommendations: [
        {
          action: "Clear chat history",
          description: "Remove messages older than 90 days.",
          category: "chat",
          estimatedSavings: 4 * 1024 * 1024,
        },
      ],
    } satisfies StorageHealth,
  },
}

export const Critical: Story = {
  args: {
    health: {
      status: "critical",
      usagePercent: 96.7,
      issues: [
        { severity: "high", message: "Storage is 96.7% full", suggestedAction: "Free space now." },
      ],
      recommendations: [
        {
          action: "Clear chat history",
          description: "Remove messages older than 30 days.",
          category: "chat",
          estimatedSavings: 12 * 1024 * 1024,
        },
      ],
    } satisfies StorageHealth,
  },
}

export const Hidden: Story = {
  args: { health: null },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when health is null → <StorageHealthDisplay {...args} />
    </div>
  ),
}
