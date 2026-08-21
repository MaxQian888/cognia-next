import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryInspector } from "./memory-inspector"
import { makeMemory, MEMORY_NOW } from "@/lib/storybook/fixtures/memory"

// The right pane of `/memory`. The Activity section renders the evidence and
// audit rows the console loads — the panel this replaced fetched both and
// showed only their counts.
const meta = {
  title: "Memory/MemoryInspector",
  component: MemoryInspector,
  args: {
    memory: makeMemory({ sourceSessionId: "ses_1", tags: ["tools", "cli"] }),
    onClose: fn(),
    onSave: fn(),
    onPinToggle: fn(),
    onArchive: fn(),
    onDelete: fn(),
    onReview: fn(),
    navPosition: { index: 2, total: 12 },
    onNavigate: fn(),
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-[24rem] border-l">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemoryInspector>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithHistory: Story = {
  args: {
    evidence: [
      {
        id: "ev_1",
        memoryId: "mem_1",
        kind: "message",
        sourceId: "msg_42",
        contaminationState: "clean",
        reviewed: true,
        createdAt: MEMORY_NOW - 86_400_000,
      },
      {
        id: "ev_2",
        memoryId: "mem_1",
        kind: "manual",
        sourceId: "manual:mem_1:v2",
        contaminationState: "clean",
        reviewed: true,
        createdAt: MEMORY_NOW - 3_600_000,
      },
    ],
    auditEvents: [
      {
        id: "au_1",
        action: "created",
        reason: "turn_extraction",
        createdAt: MEMORY_NOW - 90_000_000,
      },
      { id: "au_2", action: "revised", reason: "user", createdAt: MEMORY_NOW - 3_500_000 },
      { id: "au_3", action: "promoted", reason: "user_review", createdAt: MEMORY_NOW - 60_000 },
    ],
  },
}

export const Conflicting: Story = {
  args: {
    memory: makeMemory({ reviewStatus: "conflict", conflictWithIds: ["mem_other"] }),
    resolveMemory: () => makeMemory({ id: "mem_other", text: "The user prefers npm" }),
    onOpenResolver: fn(),
  },
}

/** ADR-0115 §7: never recalled until a human promotes it. */
export const AwaitingReview: Story = {
  args: { memory: makeMemory({ reviewStatus: "pending_instruction" }) },
}

export const Archived: Story = {
  args: { memory: makeMemory({ status: "invalidated", invalidatedAt: MEMORY_NOW }) },
}
