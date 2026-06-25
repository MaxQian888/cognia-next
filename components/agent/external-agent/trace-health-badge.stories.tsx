import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { TraceHealthBadge } from "./trace-health-badge"
import type { SessionObservationSummary } from "@/types/agent/agent-trace"

// deriveTraceHealthScore reads toolCallCount/errorCount/totalTokenCost/
// latencyP50Ms/outcome; minimal casts drive each grade tier.
const summary = (over: Partial<SessionObservationSummary>): SessionObservationSummary =>
  ({
    toolCallCount: 20,
    errorCount: 0,
    totalTokenCost: 0.02,
    latencyP50Ms: 800,
    ...over,
  }) as SessionObservationSummary

const meta = {
  title: "Agent/TraceHealthBadge",
  component: TraceHealthBadge,
  args: { summary: summary({}) },
} satisfies Meta<typeof TraceHealthBadge>

export default meta
type Story = StoryObj<typeof meta>

export const GradeA: Story = {}

export const GradeC: Story = {
  args: { summary: summary({ errorCount: 3, totalTokenCost: 1.2, latencyP50Ms: 6000 }) },
}

export const GradeF: Story = {
  args: { summary: summary({ errorCount: 12, totalTokenCost: 4, latencyP50Ms: 20000 }) },
}

export const ErrorOutcome: Story = {
  args: { summary: summary({ outcome: "error" } as Partial<SessionObservationSummary>) },
}

export const Range: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <TraceHealthBadge summary={summary({})} />
      <TraceHealthBadge summary={summary({ errorCount: 1, latencyP50Ms: 2000 })} />
      <TraceHealthBadge
        summary={summary({ errorCount: 3, totalTokenCost: 1.2, latencyP50Ms: 6000 })}
      />
      <TraceHealthBadge
        summary={summary({ errorCount: 6, totalTokenCost: 2.5, latencyP50Ms: 12000 })}
      />
      <TraceHealthBadge
        summary={summary({ errorCount: 12, totalTokenCost: 4, latencyP50Ms: 20000 })}
      />
    </div>
  ),
}
