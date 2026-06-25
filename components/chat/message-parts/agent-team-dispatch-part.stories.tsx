import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTeamDispatchPart } from "./agent-team-dispatch-part"
import type { AgentTeamDispatchPart as DispatchPartType } from "@/lib/claude/parts-extensions"

// Fully props-driven banner for one `<dispatch to="…">…</dispatch>` directive
// parsed out of a supervisor turn. No store / context — just the part + an
// optional `fromName` and display `mode`. `standard` shows the task body;
// `simplified` drops it to a compact one-liner.

const part: DispatchPartType = {
  type: "agent-team-dispatch",
  from: "supervisor",
  to: "researcher",
  toName: "Researcher",
  task: "Pull the three most-cited sources on Next.js static export limitations and summarise the trade-offs vs. an Tauri axum backend.",
  sessionId: "demo-session",
}

const meta = {
  title: "Chat/MessageParts/AgentTeamDispatchPart",
  component: AgentTeamDispatchPart,
  parameters: { layout: "padded" },
  args: { part },
} satisfies Meta<typeof AgentTeamDispatchPart>

export default meta
type Story = StoryObj<typeof meta>

// Standard mode — from→to banner with the full task body + open-member link.
export const Standard: Story = {
  args: { fromName: "Orchestrator", mode: "standard" },
}

// Simplified mode — compact single row, task body dropped, inline open link.
export const Simplified: Story = {
  args: { mode: "simplified" },
}

// Falls back to the localized "Supervisor" label when no `fromName` is given.
export const DefaultSupervisor: Story = {
  args: { mode: "standard" },
}
