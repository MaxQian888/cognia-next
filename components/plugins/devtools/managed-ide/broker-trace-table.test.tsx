/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { BrokerTraceRow } from "@/hooks/plugins/use-broker-trace"

import { BrokerTraceTable, displayPayload } from "./broker-trace-table"

const row = (seq: number, overrides: Partial<BrokerTraceRow> = {}): BrokerTraceRow => ({
  seq,
  atMs: Date.UTC(2026, 9, 3, 1, 2, 3, 4),
  root: "/w",
  generation: 1,
  direction: "inbound",
  kind: "request",
  method: "cognia/provider/invoke",
  id: `proxy:${seq}`,
  pluginId: "acme",
  bytes: 42,
  durationMs: null,
  errorCode: null,
  payload: { path: "string(9)" },
  simulated: false,
  ...overrides,
})

function renderTable(rows: BrokerTraceRow[], includePayloads = false, error: string | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrokerTraceTable rows={rows} includePayloads={includePayloads} error={error} />
    </NextIntlClientProvider>
  )
}

it("says there is nothing yet, and shows a read failure", () => {
  renderTable([], false, "host gone")
  expect(screen.getByTestId("managed-ide-trace-empty")).toHaveTextContent("No broker traffic yet")
  expect(screen.getByTestId("managed-ide-trace-error")).toHaveTextContent("host gone")
})

it("lists frames newest first with timing, size, error and the simulated badge", () => {
  renderTable([
    row(1),
    row(2, {
      kind: "response",
      direction: "outbound",
      durationMs: 12,
      errorCode: -32003,
      simulated: true,
    }),
  ])
  const rows = screen.getAllByTestId(/managed-ide-trace-row-/)
  expect(rows.map((element) => element.dataset.testid)).toEqual([
    "managed-ide-trace-row-2",
    "managed-ide-trace-row-1",
  ])
  const newest = within(rows[0])
  expect(newest.getByText("To editor")).toBeInTheDocument()
  expect(newest.getByText("Response")).toBeInTheDocument()
  expect(newest.getByText("12 ms")).toBeInTheDocument()
  expect(newest.getByText("-32003")).toBeInTheDocument()
  expect(screen.getByTestId("managed-ide-trace-simulated-2")).toHaveTextContent("Simulated")
  expect(screen.queryByTestId("managed-ide-trace-simulated-1")).toBeNull()
})

it("filters by method or plugin", async () => {
  renderTable([row(1), row(2, { method: "openFile", pluginId: null })])
  await userEvent.type(screen.getByLabelText("Filter the broker trace"), "openfile")
  expect(screen.getAllByTestId(/managed-ide-trace-row-/)).toHaveLength(1)
  await userEvent.clear(screen.getByLabelText("Filter the broker trace"))
  await userEvent.type(screen.getByLabelText("Filter the broker trace"), "nothing")
  expect(screen.getByText("Nothing matches the filter.")).toBeInTheDocument()
})

it("opens a frame's payload", async () => {
  renderTable([row(1)])
  await userEvent.click(screen.getByRole("button", { name: "cognia/provider/invoke" }))
  expect(screen.getByTestId("managed-ide-trace-payload-1")).toHaveTextContent('"path": "string(9)"')
})

describe("displayPayload", () => {
  it("shows a shape as recorded and redacts values", () => {
    expect(displayPayload(null, true)).toBeNull()
    expect(displayPayload({ to: "string(17)" }, false)).toContain("string(17)")
    const shown = displayPayload({ to: "someone@example.com" }, true)!
    expect(shown).not.toContain("someone@example.com")
    expect(shown).toMatch(/<EMAIL_\d+>/)
  })
})
