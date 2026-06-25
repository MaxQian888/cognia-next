import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubagentPart } from "./subagent-part"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgent } from "@/types/agent/sub-agent"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"

// `SubagentPart` renders a sub-agent invocation. Static identity (id, name,
// status, progress snapshot) comes from the part; LIVE `progress` + `logs`
// come from `useSubagentRuntimeStore.subAgents[id]` via subscription. Each
// story seeds the runtime entry directly so the logs/progress show through.
// Three modes: `simplified` (compact row, expandable), `standard` (card,
// collapsed) and `detailed` (card, expanded by default).

const RUNNING_ID = "sub-running"
const DONE_ID = "sub-done"

// Minimal-but-shape-accurate runtime SubAgent. We only populate the fields the
// renderer reads (status, progress, logs, result.tokenUsage, depth); the rest
// satisfy the type via `as SubAgent` to avoid the full orchestration ceremony.
const runtime = (over: Partial<SubAgent> & { id: string }): SubAgent =>
  ({
    parentAgentId: "chat",
    name: "Sub-agent",
    description: "",
    task: "",
    initialTask: "",
    threadId: "thread-1",
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActivityAt: new Date("2026-01-01T00:00:00Z"),
    retryCount: 0,
    order: 0,
    ...over,
  }) as SubAgent

const runningRuntime = runtime({
  id: RUNNING_ID,
  name: "Web Researcher",
  status: "running",
  progress: 62,
  depth: 1,
  logs: [
    { timestamp: new Date(), level: "info", message: "Querying 4 sources…" },
    { timestamp: new Date(), level: "info", message: "Ranking by recency + citation count" },
    { timestamp: new Date(), level: "debug", message: "candidate: nextjs.org/docs (0.91)" },
  ],
})

const doneRuntime = runtime({
  id: DONE_ID,
  name: "Code Reviewer",
  status: "completed",
  progress: 100,
  depth: 2,
  logs: [
    { timestamp: new Date(), level: "info", message: "Reviewed 3 files, 0 blocking issues" },
    { timestamp: new Date(), level: "warn", message: "1 nit: prefer `const` in build-options.ts" },
  ],
  result: {
    success: true,
    finalResponse: "LGTM with one nit.",
    steps: [],
    totalSteps: 4,
    duration: 8200,
    tokenUsage: { promptTokens: 3100, completionTokens: 820, totalTokens: 3920 },
  },
})

function seed(...subAgents: SubAgent[]) {
  useSubagentRuntimeStore.setState({
    subAgents: Object.fromEntries(subAgents.map((s) => [s.id, s])),
  })
}

const part = (over: Partial<SubagentPartType> & { subagentId: string }): SubagentPartType => ({
  type: "subagent",
  parentSessionId: "demo-session",
  name: "Sub-agent",
  status: "running",
  progress: 0,
  startedAt: new Date("2026-01-01T00:00:00Z").getTime() - 8200,
  ...over,
})

const meta = {
  title: "Chat/MessageParts/SubagentPart",
  component: SubagentPart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SubagentPart>

export default meta
type Story = StoryObj<typeof meta>

// Standard card, running — collapsed by default; header shows status + depth.
export const Standard: Story = {
  args: {
    part: part({
      subagentId: RUNNING_ID,
      name: "Web Researcher",
      status: "running",
      progress: 62,
      depth: 1,
    }),
    mode: "standard",
  },
  beforeEach: () => seed(runningRuntime),
}

// Detailed card, completed — expanded by default: summary, logs, token badge,
// and the open-in-workspace link all visible.
export const DetailedCompleted: Story = {
  args: {
    part: part({
      subagentId: DONE_ID,
      name: "Code Reviewer",
      status: "completed",
      progress: 100,
      depth: 2,
      summary: "Reviewed the auth refactor — approved with one style nit.",
      completedAt: new Date("2026-01-01T00:00:00Z").getTime(),
      tokenUsage: { promptTokens: 3100, completionTokens: 820, totalTokens: 3920 },
    }),
    mode: "detailed",
  },
  beforeEach: () => seed(doneRuntime),
}

// Simplified one-row layout — icon + name + last-log + duration + status glyph;
// clicking the row expands the detail body inline.
export const Simplified: Story = {
  args: {
    part: part({
      subagentId: RUNNING_ID,
      name: "Web Researcher",
      status: "running",
      progress: 62,
      depth: 1,
    }),
    mode: "simplified",
  },
  beforeEach: () => seed(runningRuntime),
}
