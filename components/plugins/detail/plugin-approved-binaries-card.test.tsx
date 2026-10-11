import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { PluginApprovedBinariesCard } from "./plugin-approved-binaries-card"
import type { ApprovedBinaryRow } from "@/lib/db/approved-binaries"

// TDZ-safe: the jest.fn lives inside the factory (jest-gotchas #1).
jest.mock("@/lib/db/approved-binaries", () => ({
  listApprovedBinaries: jest.fn(),
  revokeBinaryApproval: jest.fn(async () => {}),
}))

// useLiveQuery re-runs the querier on Dexie writes; here it just reports
// whatever `rows` currently holds.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => querier(),
}))

import { revokeBinaryApproval } from "@/lib/db/approved-binaries"
import { listApprovedBinaries } from "@/lib/db/approved-binaries"

const listMock = listApprovedBinaries as jest.Mock
const revokeMock = revokeBinaryApproval as jest.Mock

const ROW: ApprovedBinaryRow = {
  pluginId: "acme",
  binaryPath: "/plugins/acme/bin/tool",
  sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  approvedAt: Date.UTC(2026, 6, 15, 12, 0, 0),
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginApprovedBinariesCard pluginId="acme" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  listMock.mockReset()
  revokeMock.mockClear()
})

describe("PluginApprovedBinariesCard", () => {
  it("renders nothing until the live query resolves", () => {
    listMock.mockReturnValue(undefined)
    const { container } = renderCard()
    // Flashing "nothing approved" at a user who has approvals would be a lie.
    expect(container.firstChild).toBeNull()
  })

  it("states that binaries prompt every run when the ledger is empty", () => {
    listMock.mockReturnValue([])
    renderCard()
    expect(screen.getByText(/No approved binaries/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Revoke/i })).not.toBeInTheDocument()
  })

  it("lists an approval with its path and the hash it is pinned to", () => {
    listMock.mockReturnValue([ROW])
    renderCard()
    expect(screen.getByText("/plugins/acme/bin/tool")).toBeInTheDocument()
    // Truncated hash — showing it is what makes "changed bytes re-prompt"
    // verifiable rather than a claim the user must take on faith.
    expect(screen.getByText(/sha256 abcdef0123456789/)).toBeInTheDocument()
    // Matches the year, not an exact rendering: jest.setup.ts stubs next-intl's
    // `useFormatter().dateTime` to `toISOString()`, so pinning the format here
    // would assert the harness rather than the component.
    expect(screen.getByText(/Approved .*2026/)).toBeInTheDocument()
  })

  it("revokes the approval for the row's binary path", async () => {
    const user = userEvent.setup()
    listMock.mockReturnValue([ROW])
    renderCard()
    await user.click(screen.getByRole("button", { name: /Revoke the approval for/i }))
    expect(revokeMock).toHaveBeenCalledWith("acme", "/plugins/acme/bin/tool")
  })

  it("scopes the query to the plugin it renders for", () => {
    listMock.mockReturnValue([])
    renderCard()
    expect(listMock).toHaveBeenCalledWith("acme")
  })

  // The Permissions tab owns the pane: a small heading over a plain divided
  // list, with no bordered box around it.
  it("renders as a flat group: heading, description, divided list, no frame", () => {
    listMock.mockReturnValue([ROW, { ...ROW, binaryPath: "/plugins/acme/bin/other" }])
    renderCard()
    const group = screen.getByTestId("plugin-approved-binaries")
    expect(screen.getByRole("heading", { name: "Approved binaries" })).toBeInTheDocument()
    const list = screen.getByRole("list")
    expect(list.className).toContain("divide-y")
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    let node: HTMLElement | null = list
    while (node && node !== group) {
      expect(node.className).not.toMatch(/(^|\s)(rounded(-\w+)?|border)(\s|$)/)
      node = node.parentElement
    }
  })

  it("shows the whole path, wrapped, rather than truncating the binary's name", () => {
    listMock.mockReturnValue([ROW])
    renderCard()
    const path = screen.getByText("/plugins/acme/bin/tool")
    expect(path.className).not.toContain("truncate")
    expect(path.className).toContain("[overflow-wrap:anywhere]")
  })

  it("sizes the revoke action for touch", () => {
    listMock.mockReturnValue([ROW])
    renderCard()
    expect(screen.getByRole("button", { name: /Revoke the approval for/i }).className).toContain(
      "pointer-coarse:h-10"
    )
  })
})
