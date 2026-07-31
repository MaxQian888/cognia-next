import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Agent Runs - Cognia",
  description: "Live and recent goal, team, plan, and scheduled agent runs in one place.",
}

export default function AgentRunsLayout({ children }: { children: React.ReactNode }) {
  return children
}
