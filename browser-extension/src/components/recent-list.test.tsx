/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import type { BrowserContextSubmissionSummaryV1 } from "@cognia/companion-client"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { RecentList } from "./recent-list"

function makeApi(overrides: Partial<BrowserApi> = {}): BrowserApi {
  return {
    message: (key: string) => key,
    openUrl: jest.fn(async () => undefined),
    ...overrides,
  } as BrowserApi
}

function item(
  overrides: Partial<BrowserContextSubmissionSummaryV1> = {}
): BrowserContextSubmissionSummaryV1 {
  return {
    submissionId: "sub-1",
    sessionId: "session-1",
    title: "Pricing research",
    sourceHost: "example.com",
    captureMode: "selection",
    status: "running",
    submittedAt: 1,
    updatedAt: 2,
    deepLink: "cognia://session/session-1",
    ...overrides,
  }
}

describe("RecentList", () => {
  it("explains an empty list rather than showing nothing", () => {
    render(<RecentList api={makeApi()} items={[]} />)
    expect(screen.getByTestId("recent-empty")).toBeInTheDocument()
  })

  it("shows the title, the source host, and the status", () => {
    render(<RecentList api={makeApi()} items={[item()]} />)
    expect(screen.getByText("Pricing research")).toBeInTheDocument()
    expect(screen.getByText("example.com")).toBeInTheDocument()
    expect(screen.getByTestId("status-running")).toBeInTheDocument()
  })

  it("shows only the hostname, never the path", () => {
    // This list lives on disk in a browser profile. A full URL here would
    // re-introduce the identifiers the capture step stripped out.
    render(<RecentList api={makeApi()} items={[item()]} />)
    expect(screen.queryByText(/https?:\/\//)).toBeNull()
    expect(screen.queryByText(/\/pricing/)).toBeNull()
  })

  it("offers to continue rather than to approve when a task is waiting", () => {
    // The panel deliberately cannot answer a prompt (ADR-0154 §1), so it must
    // not render something that looks like it could.
    render(<RecentList api={makeApi()} items={[item({ status: "needs_input" })]} />)
    expect(screen.getByText("continueInCognia")).toBeInTheDocument()
    expect(screen.queryByText("openInCognia")).toBeNull()
  })

  it("opens the deep link in Cognia", () => {
    const openUrl = jest.fn(async () => undefined)
    render(<RecentList api={makeApi({ openUrl })} items={[item()]} />)
    fireEvent.click(screen.getByText("openInCognia"))
    expect(openUrl).toHaveBeenCalledWith("cognia://session/session-1")
  })

  it("shows the recorded reason under a failed row, and nothing under the rest", () => {
    render(
      <RecentList
        api={makeApi()}
        items={[item({ status: "failed" }), item({ submissionId: "sub-2", title: "Second" })]}
        failureCodes={{ "sub-1": "enqueue_refused" }}
      />
    )
    expect(screen.getByTestId("recent-reason-sub-1")).toHaveTextContent("reasonRefused")
    expect(screen.queryByTestId("recent-reason-sub-2")).toBeNull()
  })

  it("shows an expanded answer and flags one that was cut", () => {
    render(
      <RecentList
        api={makeApi()}
        items={[item({ status: "completed" })]}
        answers={{ "sub-1": { text: "The team plan is $20.", truncated: true } }}
        expanded={["sub-1"]}
        onToggleAnswer={() => undefined}
      />
    )
    expect(screen.getByTestId("recent-answer-sub-1")).toHaveTextContent("The team plan is $20.")
    // "the task said this" and "the task said this much of it" are different
    // claims, and the row makes the second one rather than implying the first.
    expect(screen.getByText("resultTruncated")).toBeInTheDocument()
  })

  it("offers a stop only on a task that is still going", () => {
    const onStop = jest.fn()
    render(
      <RecentList
        api={makeApi()}
        items={[item({ status: "running" }), item({ submissionId: "sub-2", status: "completed" })]}
        onStop={onStop}
      />
    )
    fireEvent.click(screen.getByTestId("recent-stop-sub-1"))
    expect(onStop).toHaveBeenCalledWith("sub-1")
    expect(screen.queryByTestId("recent-stop-sub-2")).toBeNull()
  })

  it("offers neither an answer nor a stop for work with no transcript", () => {
    // A filed issue is a card on a board: nothing is running and nothing has
    // been said. Controls that would refuse are worse than no controls.
    render(
      <RecentList
        api={makeApi()}
        items={[item({ status: "queued", workKind: "issue" })]}
        onStop={jest.fn()}
        onToggleAnswer={jest.fn()}
      />
    )
    expect(screen.queryByTestId("recent-stop-sub-1")).toBeNull()
    expect(screen.queryByTestId("recent-answer-toggle-sub-1")).toBeNull()
    // The way to reach it is still there.
    expect(screen.getByText("openInCognia")).toBeInTheDocument()
  })

  it("treats a row from an older Host as the conversation it was", () => {
    render(
      <RecentList
        api={makeApi()}
        items={[item({ status: "running" })]}
        onStop={jest.fn()}
        onToggleAnswer={jest.fn()}
      />
    )
    expect(screen.getByTestId("recent-stop-sub-1")).toBeInTheDocument()
  })

  it("keeps one row per submission", () => {
    render(
      <RecentList
        api={makeApi()}
        items={[item(), item({ submissionId: "sub-2", title: "Second" })]}
      />
    )
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })
})
