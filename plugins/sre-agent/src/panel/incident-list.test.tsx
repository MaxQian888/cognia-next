/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SreRuntime } from "../runtime"
import { createIncident, type SreIncident, type SreIncidentStatus } from "../incident/model"
import { groupIncidents, IncidentList } from "./incident-list"
import { registerSreBundle, unregisterSreBundle } from "../i18n.test-helpers"

beforeEach(() => registerSreBundle())
afterEach(() => unregisterSreBundle())

function runtime(demo = true): SreRuntime {
  return {
    sources: async () => [],
    provider: () => ({ id: "demo", kind: demo ? "fixture" : "remote", demo, coverage: null }),
  } as Partial<SreRuntime> as SreRuntime
}

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
    runtime: runtime(),
    canCreate: true,
    onOpen: jest.fn(),
    onNew: jest.fn(),
    onOpenDemo: jest.fn(),
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
    // The empty state also mounts SourcesCard; settle its query before acting.
    await waitFor(() => expect(screen.getByTestId("sre-sources")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-create-incident"))
    await userEvent.click(screen.getByTestId("sre-create-from-alert"))
    expect(props.onNew).toHaveBeenCalledTimes(1)
    expect(props.onOpenDemo).toHaveBeenCalledTimes(1)
    // The one-click path is the demo walk-through, and says so.
    expect(screen.getByTestId("sre-create-from-alert")).toHaveTextContent("Open the demo incident")
  })

  it("offers no demo incident when a live backend answers", async () => {
    renderList([], { runtime: runtime(false) })
    await waitFor(() => expect(screen.getByTestId("sre-sources")).toBeInTheDocument())
    expect(screen.queryByTestId("sre-create-from-alert")).not.toBeInTheDocument()
  })

  it("keeps 'New incident' reachable once incidents exist", async () => {
    const props = renderList([incident("a", "investigating")])
    await userEvent.click(screen.getByTestId("sre-new-incident"))
    expect(props.onNew).toHaveBeenCalledTimes(1)
  })

  it("names severity in words and an icon, not colour alone", () => {
    renderList([{ ...incident("a", "investigating"), severity: "critical" }])
    const severity = screen.getByTestId("sre-severity")
    expect(severity).toHaveTextContent("critical")
    expect(severity.querySelector("svg")).not.toBeNull()
  })

  it("shows the whole title instead of truncating it", () => {
    const title = "gateway upstream timeout after the 12:02 deploy of the router config"
    renderList([incident("a", "investigating", title)])
    const row = screen.getByTestId("sre-incident-row")
    expect(row).toHaveTextContent(title)
    expect(row.querySelector(".truncate")).toBeNull()
  })

  it("tags the demo incident", () => {
    renderList([{ ...incident("a", "investigating"), demo: true }])
    expect(screen.getByTestId("sre-incident-demo-tag")).toHaveTextContent("Demo corpus")
  })

  it("disables session-scoped creation when there is no session in front", async () => {
    renderList([], { canCreate: false })
    await waitFor(() => expect(screen.getByTestId("sre-sources")).toBeInTheDocument())
    expect(screen.getByTestId("sre-create-incident")).toBeDisabled()
    expect(screen.getByTestId("sre-create-from-alert")).toBeEnabled()
    expect(
      screen.getByText(
        "Open a conversation first — an incident belongs to the session it was opened from."
      )
    ).toBeInTheDocument()
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
