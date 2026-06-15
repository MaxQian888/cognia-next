import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { AuditTab } from "./audit-tab"
import type { GhAuditEntry } from "@/lib/github/types"

// Real ICU interpolation so `run: {id}` and `{shown} of {total}` resolve.
const MESSAGES = {
  settings: {
    githubDelivery: {
      audit: {
        disabled: "Audit log requires the GitHub Delivery plugin to be enabled.",
        loading: "Loading audit log…",
        allRepos: "All repos",
        all: "All",
        allowed: "Allowed",
        denied: "Denied",
        allActions: "All actions",
        clear: "Clear",
        count: "{shown} of {total}",
        emptyNone: "No audit entries yet. Allow / deny decisions are recorded automatically.",
        emptyFiltered: "No entries match the current filters.",
        run: "run: {id}",
      },
    },
  },
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <AuditTab />
    </NextIntlClientProvider>
  )
}

let mockRows: GhAuditEntry[] | undefined | null = null

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    table: () => ({
      orderBy: () => ({
        reverse: () => ({
          limit: () => ({ toArray: async () => mockRows ?? [] }),
        }),
      }),
    }),
  }),
}))

const makeRow = (overrides: Partial<GhAuditEntry> = {}): GhAuditEntry => ({
  repoFullName: "octocat/hello",
  runId: "run_x",
  stepId: "step_y",
  action: { kind: "merge", pr: { repo: "octocat/hello", prNumber: 1 } },
  decision: { allow: true },
  at: 1_700_000_000_000,
  reason: "policy allowed",
  ...overrides,
})

describe("AuditTab", () => {
  it("renders the plugin-disabled state when getDb returns null/throws", () => {
    mockRows = null
    renderTab()
    expect(screen.getByText(/plugin to be enabled/)).toBeInTheDocument()
  })

  it("renders loading state when rows are undefined", () => {
    mockRows = undefined
    renderTab()
    expect(screen.getByText(/Loading audit log/)).toBeInTheDocument()
  })

  it("renders the empty-table message when rows is []", () => {
    mockRows = []
    renderTab()
    expect(screen.getByText(/No audit entries yet/)).toBeInTheDocument()
  })

  it("renders all rows when no filters are active", () => {
    mockRows = [
      makeRow({ runId: "run_a" }),
      makeRow({
        runId: "run_b",
        decision: { allow: false, reason: "CI not green" },
        reason: "CI not green",
      }),
    ]
    renderTab()
    expect(screen.getByTestId("audit-list")).toBeInTheDocument()
    expect(screen.getByText("run: run_a")).toBeInTheDocument()
    expect(screen.getByText("run: run_b")).toBeInTheDocument()
  })

  it("decision=deny filter hides allow rows", () => {
    mockRows = [
      makeRow({ runId: "allow_run" }),
      makeRow({
        runId: "deny_run",
        decision: { allow: false, reason: "blocked" },
        reason: "blocked",
      }),
    ]
    renderTab()
    fireEvent.click(screen.getByTestId("audit-filter-decision"))
    // The Select uses Radix portals; click the "Denied" option by text role.
    fireEvent.click(screen.getByRole("option", { name: "Denied" }))
    expect(screen.queryByText("run: allow_run")).not.toBeInTheDocument()
    expect(screen.getByText("run: deny_run")).toBeInTheDocument()
  })

  it("'Clear' button resets all filters", () => {
    mockRows = [
      makeRow({ runId: "allow_run" }),
      makeRow({
        runId: "deny_run",
        decision: { allow: false, reason: "blocked" },
      }),
    ]
    renderTab()
    fireEvent.click(screen.getByTestId("audit-filter-decision"))
    fireEvent.click(screen.getByRole("option", { name: "Denied" }))
    expect(screen.getByTestId("audit-clear-filters")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("audit-clear-filters"))
    expect(screen.queryByTestId("audit-clear-filters")).not.toBeInTheDocument()
    expect(screen.getByText("run: allow_run")).toBeInTheDocument()
  })
})
