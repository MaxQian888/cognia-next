/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import {
  clearPluginApiAuditEvents,
  recordPluginApiAudit,
  type PluginApiAuditEvent,
} from "@/lib/plugin/contracts/interface-catalog"
import {
  ALL_FILTER,
  API_AUDIT_OUTCOMES,
  ApiAuditPane,
  filterApiAuditEvents,
  summarizeApiAudit,
} from "./api-audit-pane"

function event(overrides: Partial<PluginApiAuditEvent> = {}): PluginApiAuditEvent {
  return {
    pluginId: "demo.plugin",
    methodId: "fs.readFile",
    runtime: "frontend",
    outcome: "allowed",
    durationMs: 3.4,
    dataClassification: "workspace",
    ...overrides,
  }
}

function renderPane() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ApiAuditPane />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  clearPluginApiAuditEvents()
})

describe("filterApiAuditEvents", () => {
  const rows = [
    event({ pluginId: "a", outcome: "allowed", runtime: "frontend" }),
    event({ pluginId: "a", outcome: "denied", runtime: "frontend" }),
    event({ pluginId: "b", outcome: "allowed", runtime: "python" }),
  ]
  const base = { pluginId: ALL_FILTER, outcome: ALL_FILTER, tracedOnly: false }

  it("returns everything by default", () => {
    expect(filterApiAuditEvents(rows, base)).toHaveLength(3)
  })

  it("filters by plugin", () => {
    expect(filterApiAuditEvents(rows, { ...base, pluginId: "a" })).toHaveLength(2)
  })

  it("filters by outcome", () => {
    expect(filterApiAuditEvents(rows, { ...base, outcome: "denied" })).toHaveLength(1)
  })

  it("traced-only keeps what actually reaches Traces", () => {
    // An allowed in-renderer call is deliberately not traced, so this toggle
    // explains why a call an author just made is missing from /logs.
    const kept = filterApiAuditEvents(rows, { ...base, tracedOnly: true })
    expect(kept).toHaveLength(2)
    expect(kept.every((e) => e.outcome !== "allowed" || e.runtime !== "frontend")).toBe(true)
  })
})

describe("summarizeApiAudit", () => {
  it("counts each outcome", () => {
    expect(
      summarizeApiAudit([
        event({ outcome: "allowed" }),
        event({ outcome: "allowed" }),
        event({ outcome: "denied" }),
        event({ outcome: "error" }),
      ])
    ).toEqual({ allowed: 2, denied: 1, errored: 1 })
  })
})

describe("ApiAuditPane", () => {
  it("every outcome it can render has a translation", () => {
    for (const outcome of API_AUDIT_OUTCOMES) {
      expect(enMessages.plugins.devtools.apiAudit.outcome[outcome]).toBeTruthy()
    }
  })

  it("shows an empty state before any call is made", () => {
    renderPane()
    expect(screen.getByTestId("api-audit-empty")).toBeInTheDocument()
  })

  it("renders a row per recorded call with its verdict", () => {
    recordPluginApiAudit(event({ methodId: "fs.readFile" }))
    recordPluginApiAudit(
      event({ methodId: "net.fetch", outcome: "denied", errorCode: "permission" })
    )
    renderPane()
    expect(screen.getByText("fs.readFile")).toBeInTheDocument()
    const denied = screen.getByText("net.fetch").closest("tr")
    expect(denied).toHaveAttribute("data-outcome", "denied")
    expect(denied).toHaveTextContent("permission")
  })

  it("puts the newest call first", () => {
    // The ring has no timestamp, so order is arrival order. The call you just
    // made is the one you are looking for.
    recordPluginApiAudit(event({ methodId: "first.call" }))
    recordPluginApiAudit(event({ methodId: "second.call" }))
    renderPane()
    const methods = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent ?? "")
    expect(methods[0]).toContain("second.call")
    expect(methods[1]).toContain("first.call")
  })

  it("summarises the outcomes on screen", () => {
    recordPluginApiAudit(event({ outcome: "allowed" }))
    recordPluginApiAudit(event({ outcome: "denied" }))
    renderPane()
    expect(screen.getByTestId("api-audit-summary")).toHaveTextContent("1 allowed")
    expect(screen.getByTestId("api-audit-summary")).toHaveTextContent("1 denied")
  })

  it("picks up a call recorded while it is mounted", () => {
    renderPane()
    expect(screen.getByTestId("api-audit-empty")).toBeInTheDocument()
    act(() => recordPluginApiAudit(event({ methodId: "live.call" })))
    expect(screen.getByText("live.call")).toBeInTheDocument()
  })

  it("clears the ring from the clear button", async () => {
    recordPluginApiAudit(event())
    renderPane()
    await userEvent.click(screen.getByTestId("api-audit-clear"))
    expect(screen.getByTestId("api-audit-empty")).toBeInTheDocument()
  })
})
