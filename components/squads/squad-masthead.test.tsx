/** @jest-environment jsdom */

// The masthead renders a `SquadRunControl`. These cases pose the control
// directly, so each one is about what the reader sees for a given state; the
// state machine itself is `use-squad-run-control.test.tsx`.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadMasthead } from "./squad-masthead"
import type { SquadRunControl } from "@/hooks/squads/use-squad-run-control"
import { DEFAULT_TEAM_CONFIG, type AgentTeam } from "@/types/agent/agent-team"

const squad = {
  id: "a",
  name: "Review Crew",
  description: "Reads the diff",
  status: "idle",
  teammateIds: [],
  taskIds: [],
  messageIds: [],
  config: DEFAULT_TEAM_CONFIG,
  task: "Review release",
  leadId: "lead",
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as AgentTeam

const start = jest.fn(async () => {})
const control = jest.fn(async () => {})

function state(over: Partial<SquadRunControl> = {}): SquadRunControl {
  return {
    run: null,
    record: null,
    status: "idle",
    busy: false,
    remote: false,
    startDisabledReason: undefined,
    startOutcome: null,
    retryable: false,
    refusalMessage: undefined,
    refusalBlockers: [],
    canPause: false,
    canResume: false,
    canStop: false,
    start,
    control,
    ...over,
  }
}

function mount(over: Partial<SquadRunControl> = {}, extra: { onBack?: () => void } = {}) {
  return render(
    <SquadMasthead
      squad={squad}
      memberCount={3}
      waitingCount={0}
      control={state(over)}
      {...extra}
    />
  )
}

beforeEach(() => jest.clearAllMocks())

describe("identity", () => {
  it("names the Squad, its roster size and what it is for", () => {
    mount()
    const masthead = screen.getByTestId("squad-fleet-inspector")
    expect(screen.getByRole("heading", { name: "Review Crew" })).toBeInTheDocument()
    expect(masthead).toHaveTextContent("3 members · Reads the diff")
  })

  it("links configuration to this Squad's panel in Settings", () => {
    mount()
    expect(screen.getByTestId("squad-fleet-configure")).toHaveAttribute(
      "href",
      expect.stringContaining("squadTab=squad%3Aa")
    )
  })

  it("wears a badge counting the reviews that need you", () => {
    render(<SquadMasthead squad={squad} memberCount={3} waitingCount={2} control={state()} />)
    expect(screen.getByTestId("squad-masthead-waiting")).toHaveTextContent("2 need you")
  })

  it("offers a way back only where the host replaces the list", async () => {
    const onBack = jest.fn()
    const { unmount } = mount()
    expect(screen.queryByTestId("squad-detail-back")).not.toBeInTheDocument()
    unmount()
    mount({}, { onBack })
    await userEvent.click(screen.getByRole("button", { name: "Back to Squads" }))
    expect(onBack).toHaveBeenCalled()
  })
})

describe("controls", () => {
  it("starts on a plain gesture, replaying the attempt when the last refusal was retryable", async () => {
    const { unmount } = mount()
    await userEvent.click(screen.getByTestId("start-team"))
    expect(start).toHaveBeenLastCalledWith({ retry: false })
    unmount()
    mount({ retryable: true, startOutcome: { started: false, reason: "offline" } })
    await userEvent.click(screen.getByTestId("start-team"))
    expect(start).toHaveBeenLastCalledWith({ retry: true })
  })

  it.each([
    ["pause", "pause-team", { status: "executing", canPause: true }],
    ["resume", "resume-team", { status: "paused", canResume: true }],
    ["stop", "stop-team", { status: "executing", canStop: true }],
  ] as const)("sends %s", async (action, testId, over) => {
    mount(over as Partial<SquadRunControl>)
    await userEvent.click(screen.getByTestId(testId))
    expect(control).toHaveBeenCalledWith(action)
  })

  it("does not offer a control the run does not allow", () => {
    mount({ status: "executing", canStop: true })
    expect(screen.queryByTestId("pause-team")).not.toBeInTheDocument()
    expect(screen.getByTestId("stop-team")).toBeVisible()
  })

  /** A `title` is invisible on a touch screen, so a disabled Start says why in text. */
  it("says why Start is unavailable where everyone can read it", () => {
    mount({ startDisabledReason: "No environment is chosen." })
    expect(screen.getByTestId("start-team")).toBeDisabled()
    expect(screen.getByTestId("squad-start-reason")).toHaveTextContent(
      "Can't start yet: No environment is chosen."
    )
  })

  it("keeps quiet about the transient pending state", () => {
    mount({ busy: true, startDisabledReason: "Sending…" })
    expect(screen.queryByTestId("squad-start-reason")).not.toBeInTheDocument()
  })

  it("keeps quiet while the run is live, where Start is not on offer", () => {
    mount({ status: "executing", startDisabledReason: "Checking…" })
    expect(screen.queryByTestId("squad-start-reason")).not.toBeInTheDocument()
  })
})

describe("refusal", () => {
  it("explains a refusal with its consent code and Host blockers, and offers a retry", async () => {
    mount({
      startOutcome: { started: false, reason: "host_consent_required", consentCode: "ABC123" },
      refusalMessage: "Authorize this device on the Host, then retry this start.",
      refusalBlockers: ["No environment is chosen."],
      retryable: true,
    })
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Authorize this device")
    expect(alert).toHaveTextContent("ABC123")
    expect(alert).toHaveTextContent("No environment is chosen.")
    await userEvent.click(screen.getByRole("button", { name: "Retry this start" }))
    expect(start).toHaveBeenCalledWith({ retry: true })
  })

  it("offers no retry for a definitive refusal", () => {
    mount({
      startOutcome: { started: false, reason: "not_ready" },
      refusalMessage: "The Host cannot start this Squad yet.",
    })
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry this start" })).not.toBeInTheDocument()
  })

  it("shows nothing when the last start went through", () => {
    mount({ startOutcome: { started: true, executionRunId: "execution:team:x" } })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

/** One "Open run" per screen: the Overview's, beside the run it opens. */
it("carries no run link of its own", () => {
  mount({ run: { id: "execution:team:canonical" } as SquadRunControl["run"] })
  expect(screen.queryByRole("link", { name: "Open run" })).not.toBeInTheDocument()
})
