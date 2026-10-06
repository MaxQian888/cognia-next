/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SquadInspector } from "./squad-inspector"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { DEFAULT_TEAM_CONFIG, type AgentTeam } from "@/types/agent/agent-team"
import type { ExecutionRun, RunControlAction } from "@/types/execution/run"
import type { HostProfile } from "@/lib/platform/capabilities"
import type { SquadStartOutcome } from "@/lib/execution/squad-start-dispatch"

const mockDispatch = jest.fn<Promise<SquadStartOutcome>, []>()
const mockCreateAttempt = jest.fn()
const mockControl = jest.fn()
const mockToast = jest.fn()
let mockProfile: HostProfile = "desktop"
let mockRun: ExecutionRun | null = null
let mockBlocked = false
jest.mock("@/lib/execution/squad-start-dispatch", () => ({
  createSquadStartAttempt: (...args: unknown[]) => mockCreateAttempt(...args),
}))
jest.mock("@/lib/execution/run-control-dispatch", () => ({
  dispatchRunControl: (...args: unknown[]) => mockControl(...args),
}))
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => mockRun }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockProfile,
  useRemoteHostActive: () => false,
}))
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToast(...args) } }))
jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({
    ready: !mockBlocked,
    loading: false,
    blockers: mockBlocked ? [{ code: "host_unavailable" }] : [],
    evaluatedAt: 1,
  }),
}))
jest.mock("@/components/squads/squad-readiness-card", () => ({
  SquadReadinessCard: () => <div data-testid="squad-readiness" />,
}))

function run(allowedActions: RunControlAction[]): ExecutionRun {
  return {
    id: "execution:team:canonical",
    kind: "team",
    sourceId: "canonical",
    title: "Review",
    status: "running",
    currentRevision: 7,
    startedAt: 1,
    updatedAt: 2,
    latestSnapshot: {
      runId: "execution:team:canonical",
      kind: "team",
      teamId: "a",
      title: "Review",
      status: "running",
      revision: 7,
      startedAt: 1,
      updatedAt: 2,
      progress: { completed: 0, total: 0, trustworthy: false },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 1,
      artifacts: [],
      allowedActions,
    },
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  mockProfile = "desktop"
  mockRun = null
  mockBlocked = false
  mockDispatch.mockReset().mockResolvedValue({
    started: true,
    runId: "canonical",
    executionRunId: "execution:team:canonical",
  })
  mockCreateAttempt.mockImplementation(() => ({ launchId: "gesture", dispatch: mockDispatch }))
  mockControl.mockResolvedValue({ accepted: true })
  const squad: AgentTeam = {
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
  }
  useAgentTeamStore.setState({ teams: { a: squad } })
})

it("names the Squad, composes its body and links configuration", () => {
  render(
    <SquadInspector squadId="a">
      <span>Run body</span>
    </SquadInspector>
  )
  expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Review Crew")
  expect(screen.getByText("Run body")).toBeVisible()
  expect(screen.getByTestId("squad-fleet-configure")).toHaveAttribute(
    "href",
    expect.stringContaining("squadTab=squad%3Aa")
  )
})
it("renders nothing for a deleted Squad", () => {
  render(<SquadInspector squadId="gone" />)
  expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
})
it("starts using the surface dispatcher and links the canonical run", async () => {
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("start-team"))
  expect(mockCreateAttempt).toHaveBeenCalledWith({ teamId: "a", hostProfile: "desktop" })
  expect(screen.getByRole("link", { name: "Open run" })).toHaveAttribute(
    "href",
    "/agent-runs?kind=team&run=execution%3Ateam%3Acanonical"
  )
  expect(screen.getByTestId("start-team")).toBeDisabled()
})
it("prevents duplicate taps while a start is pending", async () => {
  let finish!: (result: SquadStartOutcome) => void
  mockDispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<SquadInspector squadId="a" />)
  await userEvent.dblClick(screen.getByTestId("start-team"))
  expect(mockCreateAttempt).toHaveBeenCalledTimes(1)
  expect(mockDispatch).toHaveBeenCalledTimes(1)
  await act(async () => finish({ started: false, reason: "not_ready" }))
})
it("shows a consent code and retries the same logical attempt", async () => {
  mockDispatch.mockResolvedValueOnce({
    started: false,
    reason: "host_consent_required",
    consentCode: "ABC123",
  })
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("start-team"))
  expect(screen.getByRole("alert")).toHaveTextContent("ABC123")
  await userEvent.click(screen.getByRole("button", { name: "Retry this start" }))
  expect(mockCreateAttempt).toHaveBeenCalledTimes(1)
  expect(mockDispatch).toHaveBeenCalledTimes(2)
})
it("permits remote admission despite local-only readiness and displays Host blockers", async () => {
  mockProfile = "mobile-companion"
  mockBlocked = true
  mockDispatch.mockResolvedValueOnce({
    started: false,
    reason: "not_ready",
    blockers: [{ code: "missing_environment_ref" }],
  })
  render(<SquadInspector squadId="a" />)
  expect(screen.getByTestId("start-team")).toBeEnabled()
  expect(screen.queryByTestId("squad-readiness")).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId("start-team"))
  expect(screen.getByRole("alert")).toHaveTextContent("No environment is chosen")
})
it("retains local readiness disabling", () => {
  mockBlocked = true
  render(<SquadInspector squadId="a" />)
  expect(screen.getByTestId("start-team")).toBeDisabled()
})
it.each([
  ["pause", "pause-team"],
  ["resume", "resume-team"],
  ["stop", "stop-team"],
] as const)("sends %s using the canonical execution id", async (action, testId) => {
  mockRun = run([action])
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId(testId))
  expect(mockControl).toHaveBeenCalledWith({
    runId: "execution:team:canonical",
    action,
    surface: "squad-inspector",
    hostProfile: "desktop",
  })
})
it("does not offer controls absent from the canonical snapshot", () => {
  mockRun = run(["stop"])
  render(<SquadInspector squadId="a" />)
  expect(screen.queryByTestId("pause-team")).not.toBeInTheDocument()
  expect(screen.getByTestId("stop-team")).toBeVisible()
})
it("explains a refused canonical control and Host consent code", async () => {
  mockRun = run(["pause"])
  mockControl.mockResolvedValueOnce({
    accepted: false,
    reason: "host_consent_required",
    consentCode: "CONTROL",
  })
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("pause-team"))
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Couldn't pause the Squad", {
      description: expect.stringContaining("CONTROL"),
    })
  )
})
it("starts a new logical gesture after a definitive refusal", async () => {
  mockDispatch.mockResolvedValueOnce({ started: false, reason: "not_ready" })
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("start-team"))
  await userEvent.click(screen.getByTestId("start-team"))
  expect(mockCreateAttempt).toHaveBeenCalledTimes(2)
})
