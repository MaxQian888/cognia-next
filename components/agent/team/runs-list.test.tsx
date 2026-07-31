/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    workflowRuns: { where: jest.fn() },
  })),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { TeamRunsList, isSynthesizedTeamRunPayload } from "./runs-list"

const renderList = (teamId: string) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TeamRunsList teamId={teamId} />
    </NextIntlClientProvider>
  )

describe("isSynthesizedTeamRunPayload", () => {
  it("accepts the synthesizer's bare { teamId } marker for this team only", () => {
    expect(isSynthesizedTeamRunPayload({ teamId: "team-1" }, "team-1")).toBe(true)
    expect(isSynthesizedTeamRunPayload({ teamId: "team-2" }, "team-1")).toBe(false)
    expect(isSynthesizedTeamRunPayload(undefined, "team-1")).toBe(false)
  })

  it("excludes 'on team finished' fan-out runs (payload carries event)", () => {
    // Same trigger kind + teamId, but a user workflow started by the
    // completion fan-out — must NOT appear in the team's run history.
    expect(
      isSynthesizedTeamRunPayload(
        { teamId: "team-1", event: "team.completed", chainDepth: 1 },
        "team-1"
      )
    ).toBe(false)
  })
})

describe("TeamRunsList", () => {
  beforeEach(() => {
    ;(useLiveQuery as jest.Mock).mockReset()
  })

  it("renders empty state when no runs", () => {
    ;(useLiveQuery as jest.Mock).mockReturnValue([])
    renderList("team-1")
    expect(screen.getByText(/No runs yet/i)).toBeInTheDocument()
  })

  it("renders a completed run row with status badge", () => {
    ;(useLiveQuery as jest.Mock).mockReturnValue([
      {
        id: "run-1",
        workflowId: "__team__:team-1:abc",
        status: "succeeded",
        triggerKind: "trigger.team",
        triggerPayload: { teamId: "team-1" },
        startedAt: Date.now(),
        completedAt: Date.now() + 5000,
      },
    ])
    renderList("team-1")
    expect(screen.getByText("run-1")).toBeInTheDocument()
    expect(screen.getByText("succeeded")).toBeInTheDocument()
  })

  it("renders a failed run with the error message", () => {
    ;(useLiveQuery as jest.Mock).mockReturnValue([
      {
        id: "run-2",
        workflowId: "__team__:team-1:abc",
        status: "failed",
        triggerKind: "trigger.team",
        triggerPayload: { teamId: "team-1" },
        startedAt: Date.now(),
        error: { message: "boom" },
      },
    ])
    renderList("team-1")
    expect(screen.getByText(/boom/)).toBeInTheDocument()
  })

  it("renders empty state when useLiveQuery returns undefined", () => {
    ;(useLiveQuery as jest.Mock).mockReturnValue(undefined)
    renderList("team-1")
    expect(screen.getByText(/No runs yet/i)).toBeInTheDocument()
  })
})
