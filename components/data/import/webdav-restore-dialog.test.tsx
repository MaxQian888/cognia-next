import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "@/components/ui/button"

const listMock = jest.fn(async (..._a: unknown[]) => [
  { name: "latest.enc.cbk", path: "/cognia-backups/latest.enc.cbk", isLatestPointer: true },
  {
    name: "cognia-backup-2026-05-30T01.enc.cbk",
    path: "/cognia-backups/cognia-backup-2026-05-30T01.enc.cbk",
    isLatestPointer: false,
  },
])
const restoreMock = jest.fn(async (..._a: unknown[]) => ({
  added: {},
  overwritten: {},
  skipped: {},
}))

jest.mock("@/lib/webdav/restore", () => ({
  listRemoteSnapshots: (...a: unknown[]) => listMock(...a),
  restoreFromWebDav: (...a: unknown[]) => restoreMock(...a),
}))
jest.mock("./import-summary", () => ({
  ImportSummary: () => <div data-testid="summary">summary</div>,
}))

import { WebDavRestoreDialog } from "./webdav-restore-dialog"

beforeEach(() => {
  listMock.mockClear()
  restoreMock.mockClear()
  restoreMock.mockResolvedValue({ added: {}, overwritten: {}, skipped: {} })
})

describe("WebDavRestoreDialog", () => {
  it("opens, lists snapshots, and restores the latest by default", async () => {
    const user = userEvent.setup()
    render(<WebDavRestoreDialog trigger={<Button>Open</Button>} />)

    await user.click(screen.getByRole("button", { name: "Open" }))
    await waitFor(() => expect(listMock).toHaveBeenCalled())
    expect(await screen.findByText("Restore from WebDAV")).toBeInTheDocument()

    await user.type(screen.getByLabelText("Passphrase"), "secret")
    await user.click(screen.getByRole("button", { name: "Restore" }))

    await waitFor(() =>
      expect(restoreMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: undefined, passphrase: "secret", mergeStrategy: "skip" })
      )
    )
    expect(await screen.findByTestId("summary")).toBeInTheDocument()
  })

  it("shows an empty state when the server has no snapshots", async () => {
    listMock.mockResolvedValueOnce([])
    const user = userEvent.setup()
    render(<WebDavRestoreDialog trigger={<Button>Open</Button>} />)
    await user.click(screen.getByRole("button", { name: "Open" }))
    expect(await screen.findByText("No snapshots found on the server.")).toBeInTheDocument()
  })

  it("surfaces a restore error", async () => {
    restoreMock.mockRejectedValueOnce(new Error("bad passphrase"))
    const user = userEvent.setup()
    render(<WebDavRestoreDialog trigger={<Button>Open</Button>} />)
    await user.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByText("Restore from WebDAV")
    await user.type(screen.getByLabelText("Passphrase"), "x")
    await user.click(screen.getByRole("button", { name: "Restore" }))
    await waitFor(() => expect(screen.getByText(/bad passphrase/)).toBeInTheDocument())
  })
})
