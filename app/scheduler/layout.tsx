import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Task Scheduler - Cognia",
  description: "Manage automated tasks and workflows",
}

export default function SchedulerLayout({ children }: { children: React.ReactNode }) {
  return children
}
