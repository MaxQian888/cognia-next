import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryEntryDetail } from "./memory-entry-detail"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

const stringEntry: SharedMemoryEntry = {
  key: "decision.reducer-fix",
  value: "Patch computePlanCounts to use <= instead of <.",
  writtenBy: "tm-lead",
  writerName: "Lead",
  writtenAt: new Date("2026-06-29T10:00:00.000Z"),
  version: 2,
  tags: ["decision", "reducer"],
}

const jsonEntry: SharedMemoryEntry = {
  key: "context.repro",
  value: { failingTest: "plan-reducer.test.ts", seed: 42, steps: ["a", "b"] },
  writtenBy: "tm-coder",
  writtenAt: new Date("2026-06-29T10:01:00.000Z"),
  version: 1,
}

const meta = {
  title: "Agent/Workspace/Settings/MemoryEntryDetail",
  component: MemoryEntryDetail,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    teamId: "team-1",
    entry: stringEntry,
    onEdit: fn(),
  },
} satisfies Meta<typeof MemoryEntryDetail>

export default meta
type Story = StoryObj<typeof meta>

export const StringValue: Story = {}

// Non-string value is pretty-printed as JSON.
export const JsonValue: Story = {
  args: { entry: jsonEntry },
}

// Null entry → renders nothing.
export const NoEntry: Story = {
  args: { entry: null },
}
