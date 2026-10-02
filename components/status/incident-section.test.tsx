import { fireEvent, render, screen, within } from "@testing-library/react"

import type { IncidentPagesState } from "@/hooks/status/use-incident-pages"
import { FIXTURE_ACTIVE_INCIDENT, FIXTURE_PAST_INCIDENT } from "@/lib/status/fixtures"

import { ActiveIncidents, PastIncidents } from "./incident-section"

function pages(overrides: Partial<IncidentPagesState> = {}): IncidentPagesState {
  return {
    incidents: [FIXTURE_PAST_INCIDENT],
    hasMore: true,
    loading: false,
    error: null,
    loadMore: jest.fn(),
    ...overrides,
  }
}

describe("ActiveIncidents", () => {
  it("shows title, impact, state, scope, source, times and the latest update from the API", () => {
    const onOpen = jest.fn()
    render(<ActiveIncidents incidents={[FIXTURE_ACTIVE_INCIDENT]} onOpen={onOpen} />)
    const article = screen.getByRole("article", { name: "Authenticated signaling failures" })
    expect(within(article).getByText("Major outage")).toBeInTheDocument()
    expect(within(article).getByText("Investigating")).toBeInTheDocument()
    expect(article).toHaveTextContent("Affects: Authenticated signaling and Relay data lane")
    expect(article).toHaveTextContent("Opened automatically by monitoring")
    expect(article).toHaveTextContent(
      "Three consecutive reference checks failed to authenticate into a test room."
    )
    expect(article).toHaveTextContent(/Started Oct 2, 2026/)
    fireEvent.click(
      within(article).getByRole("button", {
        name: "View details for Authenticated signaling failures",
      })
    )
    expect(onOpen).toHaveBeenCalledWith(FIXTURE_ACTIVE_INCIDENT.id)
  })

  it("says when nothing is active", () => {
    render(<ActiveIncidents incidents={[]} onOpen={jest.fn()} />)
    expect(screen.getByText("No active incidents.")).toBeInTheDocument()
  })
})

describe("PastIncidents", () => {
  it("lists past incidents with duration and opens their detail", () => {
    const onOpen = jest.fn()
    render(<PastIncidents pages={pages()} onOpen={onOpen} />)
    const item = screen.getByTestId("past-incident")
    expect(item).toHaveTextContent("Relay data lane interruption")
    expect(item).toHaveTextContent("Partial outage · Relay data lane")
    expect(item).toHaveTextContent("47 minutes")
    expect(within(item).getByText("Resolved")).toBeInTheDocument()
    fireEvent.click(
      within(item).getByRole("button", { name: "View details for Relay data lane interruption" })
    )
    expect(onOpen).toHaveBeenCalledWith(FIXTURE_PAST_INCIDENT.id)
  })

  it("loads more through the cursor and reports when there is nothing older", () => {
    const state = pages()
    const { rerender } = render(<PastIncidents pages={state} onOpen={jest.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Load more incidents" }))
    expect(state.loadMore).toHaveBeenCalled()

    rerender(<PastIncidents pages={pages({ loading: true })} onOpen={jest.fn()} />)
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled()

    rerender(<PastIncidents pages={pages({ hasMore: false })} onOpen={jest.fn()} />)
    expect(screen.getByTestId("incidents-exhausted")).toHaveTextContent("No older incidents.")
  })

  it("announces a failed page", () => {
    render(<PastIncidents pages={pages({ error: "network" })} onOpen={jest.fn()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Older incidents could not be loaded.")
  })

  it("says when there is no history", () => {
    render(<PastIncidents pages={pages({ incidents: [], hasMore: false })} onOpen={jest.fn()} />)
    expect(screen.getByText("No past incidents recorded.")).toBeInTheDocument()
  })

  it("offers to look for older incidents when recent history is empty", () => {
    const state = pages({ incidents: [], hasMore: true })
    render(<PastIncidents pages={state} onOpen={jest.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Look for older incidents" }))
    expect(state.loadMore).toHaveBeenCalled()
  })
})
