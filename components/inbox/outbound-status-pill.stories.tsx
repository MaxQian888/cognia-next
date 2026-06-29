import type { Meta, StoryObj } from "@storybook/nextjs"

import { OutboundStatusPill } from "./outbound-status-pill"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeOutboundJob } from "@/lib/storybook/fixtures/inbox"

const JOB_ID = "story-job"

// `OutboundStatusPill` live-queries one `outboundQueue` row by id and renders
// nothing until it exists. Seed a job per story to exercise each status +
// source-provenance badge.
const meta = {
  title: "Inbox/OutboundStatusPill",
  component: OutboundStatusPill,
  args: { jobId: JOB_ID },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OutboundStatusPill>

export default meta
type Story = StoryObj<typeof meta>

const seedJob = (over: Parameters<typeof makeOutboundJob>[0]) => async () => {
  await seedDb(async (db) => {
    await db.outboundQueue.put(makeOutboundJob({ id: JOB_ID, ...over }))
  })
}

export const Queued: Story = { beforeEach: seedJob({ status: "pending" }) }

export const Sending: Story = { beforeEach: seedJob({ status: "sending" }) }

export const Sent: Story = { beforeEach: seedJob({ status: "sent" }) }

export const Failed: Story = {
  beforeEach: seedJob({ status: "failed", attempts: 3, lastError: "platform_5xx: upstream error" }),
}

export const Deadlettered: Story = {
  beforeEach: seedJob({ status: "deadlettered", lastError: "circuit_open" }),
}

export const WorkflowSourced: Story = {
  beforeEach: seedJob({
    status: "sent",
    source: "workflow",
    sourceWorkflow: { workflowId: "wf_1", runId: "run_1", nodeId: "node_3" },
  }),
}

export const ManualSourced: Story = {
  beforeEach: seedJob({ status: "sent", source: "manual" }),
}
