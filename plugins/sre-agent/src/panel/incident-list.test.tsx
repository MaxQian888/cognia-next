/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import type { SreRuntime } from "../runtime"
import { createIncident, type SreIncident, type SreIncidentStatus } from "../incident/model"
import { groupIncidents, IncidentList } from "./incident-list"

const RUNTIME = { sources: async () => [] } as unknown as SreRuntime

function incident(id: string, status: SreIncidentStatus, title = id): SreIncident {
  return {
    ...createIncident({
      id,
      now: "2026-08-04T12:10:00.000Z",
      title,
      environment: "prod",
      window: { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" },
      services: ["gateway"],
    }),
    status,
  }
}

function renderList(
  incidents: SreIncident[],
  overrides: Partial<Parameters<typeof IncidentList>[0]> = {}
) {
  const props = {
    incidents,
    runtime: RUNTIME,
    canCreate: true,
    onOpen: jest.fn(),
    onCreate: jest.fn(),
    onCreateFromAlert: jest.fn(),
    ...overrides,
  }
  render(<IncidentList {...props} />)
  return props
}

describe("groupIncidents", () => {
  it("folds resolved and dismissed into one closed group", () => {
    const groups = groupIncidents([
      incident("a", "investigating"),
      incident("b", "unconfirmed"),
      incident("c", "resolved"),
      incident("d", "dismissed"),
    ])
    expect(groups.investigating.map((row) => row.id)).toEqual(["a"])
    expect(groups.unconfirmed.map((row) => row.id)).toEqual(["b"])
    expect(groups.closed.map((row) => row.id)).toEqual(["c", "d"])
  })
})

describe("IncidentList", () => {
  it("offers both ways in when nothing is open", async () => {
    const props = renderList([])
    expect(screen.getByTestId("sre-incident-empty")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("sre-create-incident"))
    await userEvent.click(screen.getByTestId("sre-create-from-alert"))
    expect(props.onCreate).toHaveBeenCalledTimes(1)
    expect(props.onCreateFromAlert).toHaveBeenCalledTimes(1)
  })

  it("disables session-scoped creation when there is no session in front", () => {
    renderList([], { canCreate: false })
    expect(screen.getByTestId("sre-create-incident")).toBeDisabled()
    expect(screen.getByTestId("sre-create-from-alert")).toBeEnabled()
  })

  it("counts every group in the filter row, not just the visible one", () => {
    renderList([
      incident("a", "investigating"),
      incident("b", "unconfirmed"),
      incident("c", "resolved"),
    ])
    expect(screen.getByRole("button", { name: "Open 1" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Needs confirmation 1" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Closed 1" })).toBeInTheDocument()
    expect(screen.getAllByTestId("sre-incident-row")).toHaveLength(1)
  })

  it("switches the visible group and reports an empty one honestly", async () => {
    renderList([incident("a", "investigating", "gateway timeout")])
    await userEvent.click(screen.getByRole("button", { name: "Closed 0" }))
    expect(screen.queryByTestId("sre-incident-row")).not.toBeInTheDocument()
    expect(screen.getByText("Nothing in this group.")).toBeInTheDocument()
  })

  it("opens the incident that was clicked", async () => {
    const props = renderList([incident("a", "investigating", "gateway timeout")])
    await userEvent.click(screen.getByTestId("sre-incident-row"))
    expect(props.onOpen).toHaveBeenCalledWith("a")
  })
})
