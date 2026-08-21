import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TraceWorkspace } from "./trace-workspace"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeWindowSpans } from "@/lib/storybook/fixtures/observability"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useObservabilityStore } from "@/stores/observability/observability-store"

// `TraceWorkspace` is the WHOLE `/logs` Traces channel: the shared toolbar, the
// Explore ↔ Dashboard switch, and the single Dexie window read both sub-views
// are folds of. These stories run it live — real `useObservabilityData`,
// `useObservabilitySeries` and `useTraceList` over seeded `agentTraces` rows —
// because the point of the merge is that the list and the panels agree, and a
// props-only harness could not show that.
//
// Layout is decided by the channel's OWN measured width, so the decorator's box
// IS the story variable: 1400px gets three columns, 950px two, 700px the list
// with a sheet, and the toolbar collapses on its own slot (see `Narrow`).

const SPANS = makeWindowSpans()

/** Seed a populated window and start from the shipped store defaults. */
async function seedPopulated(): Promise<void> {
  resetStore(useObservabilityStore)
  await seedDb(async (db) => {
    await db.agentTraces.bulkPut(SPANS)
  })
}

/**
 * The channel is controlled by `/logs`; stories hold that state locally so the
 * sub-view switch, the errors-only toggle and trace selection actually work,
 * while still reporting through to the Actions panel.
 */
function InteractiveTraceWorkspace(props: React.ComponentProps<typeof TraceWorkspace>) {
  const [subView, setSubView] = useState(props.subView)
  const [errorsOnly, setErrorsOnly] = useState(props.errorsOnly)
  const [selectedTraceId, setSelectedTraceId] = useState(props.selectedTraceId)

  return (
    <TraceWorkspace
      {...props}
      subView={subView}
      onSubViewChange={(next) => {
        setSubView(next)
        props.onSubViewChange(next)
      }}
      errorsOnly={errorsOnly}
      onErrorsOnlyChange={(next) => {
        setErrorsOnly(next)
        props.onErrorsOnlyChange(next)
      }}
      selectedTraceId={selectedTraceId}
      onSelectTrace={(next) => {
        setSelectedTraceId(next)
        props.onSelectTrace(next)
      }}
    />
  )
}

/** Fixed-width box so the container-measured tiers are the story's subject. */
function box(width: number) {
  return function Box(Story: () => React.ReactElement) {
    return (
      <div className="flex h-[720px] flex-col border" style={{ width }}>
        <Story />
      </div>
    )
  }
}

const meta = {
  title: "Logging/TraceWorkspace",
  component: TraceWorkspace,
  parameters: { layout: "fullscreen" },
  args: {
    subView: "explore",
    onSubViewChange: fn(),
    errorsOnly: false,
    onErrorsOnlyChange: fn(),
    selectedTraceId: null,
    onSelectTrace: fn(),
    onOpenInLogs: fn(),
    onOpenSession: fn(),
  },
  render: (args) => <InteractiveTraceWorkspace {...args} />,
  beforeEach: seedPopulated,
  decorators: [box(1400)],
} satisfies Meta<typeof TraceWorkspace>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The wide tier: trace list │ timeline + waterfall │ span detail, with the
 * expanded toolbar on one row. `trace-05` is the seeded failing trace, so the
 * error styling and the tool-failure span are both on screen.
 */
export const Explore: Story = {
  args: { selectedTraceId: "trace-05" },
}

/** The aggregate half of the same read — KPIs, series and breakdowns. */
export const Dashboard: Story = {
  args: { subView: "dashboard" },
}

/**
 * A filter set on the dashboard narrows the Explore list too, because both are
 * folds of one `useObservabilityData` read. Switch sub-views to see it.
 */
export const FilteredAcrossBothSubViews: Story = {
  args: { subView: "dashboard" },
  beforeEach: async () => {
    await seedPopulated()
    useObservabilityStore.getState().setFilters({ surface: ["chat"] })
  },
}

/**
 * Under 1180px the third column goes: the span detail stacks under the
 * waterfall rather than squeezing it below readable width.
 */
export const SplitLayout: Story = {
  args: { selectedTraceId: "trace-05" },
  decorators: [box(950)],
}

/**
 * Under 768px only the list survives (the waterfall + span detail move into a
 * bottom sheet), and the toolbar's slot drops under 1120px so the seven filter
 * dropdowns fold behind one trigger.
 */
export const Narrow: Story = {
  decorators: [box(700)],
}

/** Phone width: paired KPI tiles, full-width charts, icon-only sub-view tabs. */
export const NarrowDashboard: Story = {
  args: { subView: "dashboard" },
  decorators: [box(390)],
}

/** No spans in the window at all — the dashboard's own empty state. */
export const EmptyWindow: Story = {
  args: { subView: "dashboard" },
  beforeEach: async () => {
    resetStore(useObservabilityStore)
    await seedDb(async () => {})
  },
}
