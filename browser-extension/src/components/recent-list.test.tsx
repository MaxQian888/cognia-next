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
