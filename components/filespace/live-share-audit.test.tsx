import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/filespace/grants-client", () => ({
  ...jest.requireActual("@/lib/filespace/grants-client"),
  listFileShareAuditPage: jest.fn(),
}))

import { listFileShareAuditPage } from "@/lib/filespace/grants-client"
import type { Transport } from "@/lib/tauri/transport-types"
import type { FileShareAuditRow } from "@/types/filespace/live"

import { LiveShareAudit } from "./live-share-audit"

const pageMock = listFileShareAuditPage as jest.Mock

function row(id: number, patch: Partial<FileShareAuditRow> = {}): FileShareAuditRow {
  return {
    id,
    at: 1_700_000_000_000 + id,
    sessionId: "s1",
    grantId: "fg_1",
    principal: "credential:cg_user",
    channel: "webdav",
    action: "read",
    path: `/workspace/f${id}.txt`,
    bytes: 10,
    outcome: "allowed",
    reason: null,
    remote: "127.0.0.1",
    ...patch,
  }
}

beforeEach(() => jest.clearAllMocks())

describe("LiveShareAudit", () => {
  it("lists one grant's activity from its host, with who and how", async () => {
    pageMock.mockResolvedValue({
      items: [
        row(2, { principal: "owner", channel: "app", action: "grant.create", path: null }),
        row(1, { outcome: "denied", reason: "sensitive" }),
      ],
    })
    render(<LiveShareAudit grantId="fg_1" hostId="local" />)
    const created = await screen.findByTestId("live-audit-2")
    expect(within(created).getByText("You")).toBeInTheDocument()
    expect(within(created).getByText("App")).toBeInTheDocument()
    const denied = screen.getByTestId("live-audit-1")
    expect(within(denied).getByText("cg_user")).toBeInTheDocument()
    expect(within(denied).getByText("Denied")).toHaveAttribute("title", "sensitive")
    expect(pageMock).toHaveBeenCalledWith({ grantId: "fg_1", pageSize: 50 }, { hostId: "local" })
  })

  it("names paired devices and the system", async () => {
    pageMock.mockResolvedValue({
      items: [
        row(2, { principal: "device:dev-9" }),
        row(1, { principal: "system", channel: "sftpgo" }),
      ],
    })
    render(<LiveShareAudit />)
    expect(await screen.findByText("Paired device dev-9")).toBeInTheDocument()
    expect(screen.getByText("Cognia")).toBeInTheDocument()
    expect(screen.getByText("SFTPGo")).toBeInTheDocument()
  })

  it("loads the next page on request and keeps the first", async () => {
    const user = userEvent.setup()
    const transport = { call: jest.fn() } as unknown as Transport
    pageMock
      .mockResolvedValueOnce({ items: [row(3)], nextPageToken: "a1:3" })
      .mockResolvedValueOnce({ items: [row(2)] })
    render(<LiveShareAudit sessionId="s1" transport={transport} />)
    await screen.findByTestId("live-audit-3")
    await user.click(screen.getByRole("button", { name: "Load more" }))
    await screen.findByTestId("live-audit-2")
    expect(screen.getByTestId("live-audit-3")).toBeInTheDocument()
    expect(pageMock).toHaveBeenLastCalledWith(
      { sessionId: "s1", pageSize: 50, pageToken: "a1:3" },
      { transport }
    )
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull()
  })

  it("says when there is nothing yet", async () => {
    pageMock.mockResolvedValue({ items: [] })
    render(<LiveShareAudit sessionId="s1" />)
    expect(await screen.findByText("No activity yet.")).toBeInTheDocument()
  })

  it("explains a failed page and retries it", async () => {
    const user = userEvent.setup()
    pageMock
      .mockRejectedValueOnce({ code: "file_share_locked", message: "x", retryable: false })
      .mockResolvedValueOnce({ items: [row(1)] })
    render(<LiveShareAudit sessionId="s1" />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Unlock your account")
    await user.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByTestId("live-audit-1")).toBeInTheDocument())
  })

  it("falls back to a plain sentence for an unknown failure", async () => {
    pageMock.mockRejectedValue(new Error("socket"))
    render(<LiveShareAudit sessionId="s1" />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the activity.")
  })
})
