/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RadarSuggestions, RadarSource, RadarTaskResults } from "./radar-suggestions"
import type { RadarReport } from "@/types/radar"

const mockDecide = jest.fn()
jest.mock("@/lib/radar/suggestions", () => ({
  ...jest.requireActual("@/lib/radar/suggestions"),
  decideRadarSuggestion: (...args: unknown[]) => mockDecide(...args),
}))
const mockLiveQuery = jest.fn(() => null as unknown)
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockLiveQuery() }))
jest.mock("@/components/scheduler/run-artifact-links", () => ({
  RunArtifactLinks: ({ output }: { output: { goalId: string } }) => <span>{output.goalId}</span>,
}))
const report = { id: "r", actions: ["Read the source"] } as RadarReport

beforeEach(() => {
  mockDecide.mockReset().mockResolvedValue(undefined)
  mockLiveQuery.mockReturnValue(null)
})

it("offers explicit accept/dismiss decisions with honest evidence fallback", async () => {
  render(<RadarSuggestions report={report} />)
  expect(screen.getByText(/No verified source reference/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Accept and run" }))
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith("r", "r:action:0", "accepted"))
})

it("keeps accepted task links and offers dispatch recovery after failure", async () => {
  render(
    <RadarSuggestions
      report={{
        ...report,
        suggestions: [
          { id: "s", actionIndex: 0, status: "accepted", taskId: "task", dispatchError: "offline" },
        ],
      }}
    />
  )
  expect(screen.getByRole("link")).toHaveAttribute("href", "/scheduler?taskId=task")
  fireEvent.click(screen.getByRole("button", { name: "Retry dispatch" }))
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith("r", "s", "accepted"))
})

it("never displays a saved copy after a source is deleted", () => {
  render(<RadarSource source={{ id: "deleted", source: "memory", at: 1 }} />)
  expect(screen.getByText(/Source was deleted/)).toBeInTheDocument()
  expect(screen.queryByRole("link")).toBeNull()
})

it("links the goal output from the same persisted scheduler task", () => {
  mockLiveQuery.mockReturnValue({
    output: { goalId: "goal-to-review", sessionId: "result-session" },
  })
  render(<RadarTaskResults taskId="task" />)
  expect(screen.getByText("goal-to-review")).toBeInTheDocument()
})

it("stamps a source in the app's locale, not the OS default", () => {
  // Swap the global next-intl mock's locale: a Chinese UI on an English OS
  // must still read its dates in Chinese.
  const intl = jest.requireMock("next-intl") as { useLocale: () => string }
  const spy = jest.spyOn(intl, "useLocale").mockReturnValue("zh-CN")
  try {
    const at = Date.UTC(2026, 9, 9, 6, 30)
    const { container } = render(<RadarSource source={{ id: "m", source: "memory", at }} />)
    const time = container.querySelector("time")
    const options = { dateStyle: "medium", timeStyle: "short" } as const
    const zh = new Intl.DateTimeFormat("zh-CN", options).format(at)
    expect(zh).not.toBe(new Intl.DateTimeFormat("en", options).format(at))
    expect(time).toHaveTextContent(zh)
    expect(time).toHaveAttribute("dateTime", new Date(at).toISOString())
  } finally {
    spy.mockRestore()
  }
})
