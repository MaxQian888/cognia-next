import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BridgeAuditPanel } from "./audit-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

type Row = {
  id: number
  ts: number
  tool: string
  scope: string
  allowed: boolean
  latencyMs: number
  reason?: string
}

let liveRows: Row[] = []
let lastFilter: unknown
const mockList = jest.fn()
const mockClear = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    // Run the query fn so the filter it builds is observable — the whole point
    // of this panel is that it finally passes the filters the helper supports.
    lastFilter = fn()
    return liveRows
  },
}))
jest.mock("@/lib/db/mcp-audit-log", () => ({
  listMcpAuditLog: (filter: unknown) => {
    mockList(filter)
    return filter
  },
  clearMcpAuditLog: () => mockClear(),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const row = (over: Partial<Row> = {}): Row => ({
  id: 1,
  ts: Date.UTC(2026, 6, 28, 9, 0),
  tool: "wiki_search",
  scope: "wiki:cognia",
  allowed: true,
  latencyMs: 12,
  ...over,
})

beforeEach(() => {
  liveRows = []
  lastFilter = undefined
  mockList.mockReset()
  mockClear.mockReset().mockResolvedValue(undefined)
})

describe("BridgeAuditPanel", () => {
  it("defaults to 50 rows with no filters", () => {
    render(<BridgeAuditPanel />)
    expect(lastFilter).toEqual({ limit: 50 })
  })

  it("passes the tool filter the helper has always supported", async () => {
    const user = userEvent.setup()
    render(<BridgeAuditPanel />)

    await user.type(screen.getByLabelText("audit.tool"), "wiki_search")

    await waitFor(() => expect(lastFilter).toEqual({ limit: 50, tool: "wiki_search" }))
  })

  it("passes the denied-only filter", () => {
    render(<BridgeAuditPanel />)

    fireEvent.click(screen.getByTestId("bridge-audit-denied-only"))

    expect(lastFilter).toEqual({ limit: 50, deniedOnly: true })
  })

  it("lets the row limit be raised past the hard-coded 50", async () => {
    const user = userEvent.setup()
    render(<BridgeAuditPanel />)

    await user.click(screen.getByRole("combobox", { name: "audit.rowLimit" }))
    await user.click(await screen.findByRole("option", { name: "audit.rowLimitValue:250" }))

    await waitFor(() => expect(lastFilter).toEqual({ limit: 250 }))
  })

  it("omits blank filters rather than sending empty strings", async () => {
    const user = userEvent.setup()
    render(<BridgeAuditPanel />)

    await user.type(screen.getByLabelText("audit.tool"), "  ")

    expect(lastFilter).toEqual({ limit: 50 })
  })

  it("renders rows with tool, scope and outcome", () => {
    liveRows = [row(), row({ id: 2, allowed: false, tool: "rag_query" })]
    render(<BridgeAuditPanel />)

    expect(screen.getByText("wiki_search")).toBeInTheDocument()
    expect(screen.getByText("rag_query")).toBeInTheDocument()
    expect(screen.getByText("audit.statusOk")).toBeInTheDocument()
    expect(screen.getByText("audit.statusDeny")).toBeInTheDocument()
  })

  it("surfaces a denial reason that used to hide in a title attribute", async () => {
    // Invisible on touch, to screen readers, and to anyone who did not think to
    // hover that exact cell.
    const user = userEvent.setup()
    liveRows = [row({ allowed: false, reason: "scope rag:user-repo is not granted" })]
    render(<BridgeAuditPanel />)

    await user.click(screen.getByRole("button", { name: "audit.detailAria:wiki_search" }))

    expect(await screen.findByTestId("bridge-audit-detail-1")).toHaveTextContent(
      "scope rag:user-repo is not granted"
    )
  })

  it("omits the reason term on an allowed call", async () => {
    const user = userEvent.setup()
    liveRows = [row({ allowed: true, reason: undefined })]
    render(<BridgeAuditPanel />)

    await user.click(screen.getByRole("button", { name: "audit.detailAria:wiki_search" }))

    const detail = await screen.findByTestId("bridge-audit-detail-1")
    expect(detail).not.toHaveTextContent("audit.reason")
  })

  it("shows the empty state and disables clearing when there is nothing to clear", () => {
    render(<BridgeAuditPanel />)

    expect(screen.getByText("audit.empty")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "audit.clearAria" })).toBeDisabled()
  })

  it("clears only after confirmation", async () => {
    liveRows = [row()]
    render(<BridgeAuditPanel />)

    fireEvent.click(screen.getByRole("button", { name: "audit.clearAria" }))
    expect(mockClear).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByText("audit.clearConfirm"))
    await waitFor(() => expect(mockClear).toHaveBeenCalled())
  })
})
