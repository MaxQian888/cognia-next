import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StorageBreakdown } from "./storage-breakdown"
import type { StorageCategoryInfo } from "@/lib/storage"

const formatBytes = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`

const cat = (over: Partial<StorageCategoryInfo>): StorageCategoryInfo => ({
  category: "chat",
  displayName: "Messages",
  itemCount: 100,
  totalSize: 8 * 1024 * 1024,
  sources: ["messages"],
  ...over,
})

const categories: StorageCategoryInfo[] = [
  cat({ category: "chat", displayName: "Messages", totalSize: 8 * 1024 * 1024, itemCount: 1200 }),
  cat({ category: "session", displayName: "Sessions", totalSize: 3 * 1024 * 1024, itemCount: 80 }),
  cat({
    category: "character",
    displayName: "Characters",
    totalSize: 1.5 * 1024 * 1024,
    itemCount: 12,
  }),
  cat({ category: "skill", displayName: "Skills", totalSize: 1024 * 1024, itemCount: 20 }),
  cat({
    category: "backupHistory",
    displayName: "Backup history",
    totalSize: 512 * 1024,
    itemCount: 5,
  }),
  cat({ category: "vector", displayName: "Vectors", totalSize: 256 * 1024, itemCount: 3 }),
]

// Pure props — stacked bar + collapsible per-category detail. Empty categories
// render the "no data" state.
const meta = {
  title: "Data/StorageBreakdown",
  component: StorageBreakdown,
  args: {
    categories,
    totalSize: categories.reduce((s, c) => s + c.totalSize, 0),
    formatBytes,
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StorageBreakdown>

export default meta
type Story = StoryObj<typeof meta>

export const WithData: Story = {}

export const Clearable: Story = { args: { onClearCategory: fn() } }

export const Empty: Story = { args: { categories: [], totalSize: 0 } }
