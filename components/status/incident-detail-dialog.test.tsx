import { fireEvent, render, screen, within } from "@testing-library/react"

import type { IncidentDetailState } from "@/hooks/status/use-incident-detail"
import { FIXTURE_ACTIVE_INCIDENT } from "@/lib/status/fixtures"
import type { IncidentDetail } from "@/lib/status/public-status"

import { IncidentDetailDialog } from "./incident-detail-dialog"

const detail: IncidentDetail = {
  ...FIXTURE_ACTIVE_INCIDENT,
  state: "monitoring",
  predecessorId: "inc_previous",
  updates: [
    FIXTURE_ACTIVE_INCIDENT.latestUpdate!,
    {
      ...FIXTURE_ACTIVE_INCIDENT.latestUpdate!,
      id: "upd_2",
      state: "identified",
      message: { en: "A deploy broke room authentication.", "zh-CN": "一次部署破坏了房间认证。" },
      source: "manual",
      at: "2026-10-02T09:58:00.000Z",
    },
    {
      ...FIXTURE_ACTIVE_INCIDENT.latestUpdate!,
      id: "upd_3",
      state: "monitoring",
      message: { en: "Rolled back; watching.", "zh-CN": "已回滚，观察中。" },
      source: "manual",
      at: "2026-10-02T09:59:00.000Z",
      correctionOf: "upd_2",
    },
  ],
}

function state(overrides: Partial<IncidentDetailState>): IncidentDetailState {
  return {
    selectedId: detail.id,
    status: "ready",
    detail,
    errorKind: null,
    open: jest.fn(),
    close: jest.fn(),
    retry: jest.fn(),
    ...overrides,
  }
}

describe("IncidentDetailDialog", () => {
  it("stays closed when nothing is selected", () => {
    render(
      <IncidentDetailDialog state={state({ selectedId: null, status: "idle", detail: null })} />
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("shows the update timeline newest first with sources and corrections", () => {
    const current = state({})
    render(<IncidentDetailDialog state={current} />)
    const dialog = screen.getByRole("dialog", { name: "Authenticated signaling failures" })
    expect(
      within(dialog)
        .getAllByTestId("incident-update-state")
        .map((node) => node.textContent)
    ).toEqual(["Monitoring", "Identified", "Investigating"])
    expect(dialog).toHaveTextContent("Rolled back; watching.")
    expect(dialog).toHaveTextContent("Correction to an earlier update")
    expect(dialog).toHaveTextContent("Posted by an operator")
    expect(dialog).toHaveTextContent("Affects: Authenticated signaling and Relay data lane")
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open the earlier incident this follows" })
    )
    expect(current.open).toHaveBeenCalledWith("inc_previous")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(current.close).toHaveBeenCalled()
  })

  it("explains a missing incident", () => {
    render(<IncidentDetailDialog state={state({ status: "not_found", detail: null })} />)
    expect(screen.getByRole("alert")).toHaveTextContent("This incident could not be found.")
  })

  it("explains an invalid link", () => {
    render(
      <IncidentDetailDialog state={state({ selectedId: null, status: "invalid", detail: null })} />
    )
    expect(screen.getByRole("alert")).toHaveTextContent("This incident link is not valid.")
  })

  it("offers a retry after an error", () => {
    const current = state({ status: "error", detail: null, errorKind: "timeout" })
    render(<IncidentDetailDialog state={current} />)
    expect(screen.getByRole("alert")).toHaveTextContent("did not answer in time")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(current.retry).toHaveBeenCalled()
  })

  it("announces loading", () => {
    render(<IncidentDetailDialog state={state({ status: "loading", detail: null })} />)
    expect(screen.getByRole("status")).toHaveTextContent("Loading incident…")
  })
})
