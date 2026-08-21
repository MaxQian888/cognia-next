/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadRunPart } from "./squad-run-part"
import type { SquadRunPart as SquadRunPartType } from "@/lib/claude/parts-extensions"
import type { ExecutionRunDetailState } from "@/hooks/agent-runs/use-execution-run-detail"
import type { RunActivitySnapshot } from "@/types/execution/run"

const detailState: { current: ExecutionRunDetailState } = {
  current: {
    detail: {
      activities: [],
      omittedActivityCount: 0,
      artifacts: [],
      verifications: [],
      changes: [],
    },
    interrupts: [],
    journalAvailable: true,
    isLoading: false,
  },
}
jest.mock("@/hooks/agent-runs/use-execution-run-detail", () => ({
  useExecutionRunDetail: () => detailState.current,
}))

const PART: SquadRunPartType = {
  type: "squad-run",
  runId: "execution:team:run_team_abc",
  squadId: "sq-1",
  squadName: "Research Squad",
  objective: "Audit the auth flow",
}

function activity(over: Partial<RunActivitySnapshot> = {}): RunActivitySnapshot {
  return {
    id: "a1",
    kind: "tool",
    category: "tool",
    status: "completed",
    label: "Read auth.ts",
    startedAt: 1,
    ...over,
  } as RunActivitySnapshot
}

function setDetail(over: Partial<ExecutionRunDetailState>) {
  detailState.current = {
    ...detailState.current,
    ...over,
    detail: { ...detailState.current.detail, ...(over.detail ?? {}) },
  }
}

beforeEach(() => {
  detailState.current = {
    detail: {
      activities: [],
      omittedActivityCount: 0,
      artifacts: [],
      verifications: [],
      changes: [],
    },
    interrupts: [],
    journalAvailable: true,
    isLoading: false,
  }
})

describe("SquadRunPart", () => {
  it("names the Squad and what it was asked to do", () => {
    render(<SquadRunPart part={PART} />)
    expect(screen.getByTestId("squad-run-part")).toHaveTextContent("Research Squad")
    expect(screen.getByTestId("squad-run-part")).toHaveTextContent("Audit the auth flow")
  })

  it("links to the run so the full detail is one click away", () => {
    render(<SquadRunPart part={PART} />)
    expect(screen.getByTestId("squad-run-open")).toHaveAttribute(
      "href",
      "/agent-runs?run=execution%3Ateam%3Arun_team_abc"
    )
  })

  it("says the run is not here rather than showing a status it cannot know", () => {
    setDetail({ run: undefined, isLoading: false })
    render(<SquadRunPart part={PART} />)
    expect(screen.getByTestId("squad-run-unknown")).toBeInTheDocument()
  })

  it("folds member activity away by default and opens on request", async () => {
    // A Squad is an executor; its members are implementation detail. Unfolded
    // by default they would flood the conversation.
    setDetail({
      run: { status: "running" } as never,
      detail: { activities: [activity(), activity({ id: "a2", label: "Edit auth.ts" })] } as never,
    })
    render(<SquadRunPart part={PART} />)
    expect(screen.queryByTestId("squad-run-activity-list")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("squad-run-activity-toggle"))
    expect(screen.getAllByTestId("squad-run-activity")).toHaveLength(2)
  })

  it("distinguishes 'no journal on this device' from 'nothing happened'", () => {
    // An empty list on a phone would claim the Squad did nothing.
    setDetail({ run: { status: "completed" } as never, journalAvailable: false })
    render(<SquadRunPart part={PART} />)
    expect(screen.getByTestId("squad-run-no-journal")).toBeInTheDocument()
    expect(screen.queryByTestId("squad-run-activity-toggle")).not.toBeInTheDocument()
  })

  it("says how many steps the rolling window dropped", async () => {
    setDetail({
      run: { status: "completed" } as never,
      detail: { activities: [activity()], omittedActivityCount: 12 } as never,
    })
    render(<SquadRunPart part={PART} />)
    await userEvent.click(screen.getByTestId("squad-run-activity-toggle"))
    expect(screen.getByText(/12 earlier steps not shown/)).toBeInTheDocument()
  })

  it("shows no activity affordance when the run genuinely has none", () => {
    setDetail({ run: { status: "queued" } as never })
    render(<SquadRunPart part={PART} />)
    expect(screen.queryByTestId("squad-run-activity-toggle")).not.toBeInTheDocument()
    expect(screen.queryByTestId("squad-run-no-journal")).not.toBeInTheDocument()
  })
})
