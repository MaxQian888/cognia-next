/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadRunPart } from "./squad-run-part"
import type { SquadRunPart as SquadRunPartType } from "@/lib/claude/parts-extensions"
import { getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import type { ExecutionRun, ExecutionRunStatus } from "@/types/execution/run"

const RUN_ID = "execution:team:run_team_abc"

const PART: SquadRunPartType = {
  type: "squad-run",
  runId: RUN_ID,
  squadId: "sq-1",
  squadName: "Research Squad",
  objective: "Audit the auth flow",
}

async function seedRun(status: ExecutionRunStatus = "running") {
  const now = Date.now()
  await createExecutionRun({
    id: RUN_ID,
    kind: "team",
    sourceId: "run_team_abc",
    title: "Audit the auth flow",
    status,
    currentRevision: 0,
    startedAt: now,
    updatedAt: now,
  } as ExecutionRun)
}

async function seedStep(stepId: string, title: string, terminal?: "completed" | "failed") {
  await runEventJournal.append(RUN_ID, semanticRunEvent("step.started", { stepId, title }))
  if (terminal) {
    await runEventJournal.append(RUN_ID, semanticRunEvent(`step.${terminal}`, { stepId }))
  }
}

beforeEach(async () => {
  const db = getDb()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
}, 30_000)

describe("SquadRunPart", () => {
  it("names the Squad and what it was asked to do", () => {
    render(<SquadRunPart part={PART} />)
    const node = screen.getByTestId("squad-run-part")
    expect(node).toHaveTextContent("Research Squad")
    expect(node).toHaveTextContent("Audit the auth flow")
  })

  it("links to the run so the full detail is one click away", () => {
    render(<SquadRunPart part={PART} />)
    expect(screen.getByTestId("squad-run-open")).toHaveAttribute(
      "href",
      "/agent-runs?run=execution%3Ateam%3Arun_team_abc"
    )
  })

  it("says the run is not here rather than showing a status it cannot know", async () => {
    render(<SquadRunPart part={PART} />)
    await waitFor(() => expect(screen.getByTestId("squad-run-unknown")).toBeInTheDocument())
  })

  it("shows the run's live status", async () => {
    await seedRun("failed")
    render(<SquadRunPart part={PART} />)
    await waitFor(() => expect(screen.getByTestId("squad-run-part")).toHaveTextContent("Failed"))
  })

  it("folds steps away by default and opens on request", async () => {
    // A Squad is an executor; its steps are implementation detail. Unfolded by
    // default they would flood the conversation.
    await seedRun()
    await seedStep("t1", "Read auth.ts", "completed")
    await seedStep("t2", "Edit auth.ts")
    render(<SquadRunPart part={PART} />)
    await waitFor(() => expect(screen.getByTestId("squad-run-activity-toggle")).toBeInTheDocument())
    expect(screen.queryByTestId("squad-run-activity-list")).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId("squad-run-activity-toggle"))
    const rows = screen.getAllByTestId("squad-run-activity")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("Read auth.ts")
    expect(rows[0]).toHaveTextContent("Done")
    expect(rows[1]).toHaveTextContent("Running")
  })

  it("shows no activity affordance when the run has produced no steps", async () => {
    await seedRun("queued")
    render(<SquadRunPart part={PART} />)
    await waitFor(() => expect(screen.getByTestId("squad-run-part")).toHaveTextContent("Queued"))
    expect(screen.queryByTestId("squad-run-activity-toggle")).not.toBeInTheDocument()
  })
})
