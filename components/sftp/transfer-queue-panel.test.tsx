import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TransferQueuePanel } from "./transfer-queue-panel"
import type { SftpTransferRow } from "@/lib/sftp/transfer-types"

let rows: SftpTransferRow[] = []
let emit: ((next: SftpTransferRow[]) => void) | null = null
const pauseSftpTransfer = jest.fn()
const resumeSftpTransfer = jest.fn()
const cancelSftpTransfer = jest.fn()
const retrySftpTransfer = jest.fn()
const clearFinishedSftpTransfers = jest.fn()
const setSftpTransferApproval = jest.fn()
const requestSftpTransferApproval = jest.fn()
const downloadBlob = jest.fn()

jest.mock("@/lib/sftp/transfer-queue", () => {
  const actual = jest.requireActual("@/lib/sftp/transfer-types")
  return {
    SFTP_APPROVAL_REQUIRED: "sftp_approval_required",
    isSftpTransferFinished: actual.isSftpTransferFinished,
    observeSftpTransfers: () => ({
      subscribe: ({ next }: { next: (value: SftpTransferRow[]) => void }) => {
        emit = next
        next(rows)
        return { unsubscribe: () => undefined }
      },
    }),
    pauseSftpTransfer: (...args: unknown[]) => pauseSftpTransfer(...args),
    resumeSftpTransfer: (...args: unknown[]) => resumeSftpTransfer(...args),
    cancelSftpTransfer: (...args: unknown[]) => cancelSftpTransfer(...args),
    retrySftpTransfer: (...args: unknown[]) => retrySftpTransfer(...args),
    clearFinishedSftpTransfers: (...args: unknown[]) => clearFinishedSftpTransfers(...args),
    setSftpTransferApproval: (...args: unknown[]) => setSftpTransferApproval(...args),
  }
})
jest.mock("@/lib/sftp/client", () => ({
  requestSftpTransferApproval: () => requestSftpTransferApproval(),
}))
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}))

function row(overrides: Partial<SftpTransferRow> = {}): SftpTransferRow {
  return {
    id: "t1",
    profileId: "production",
    profileLabel: "Production",
    remotePath: "/var/log/app.log",
    fileName: "app.log",
    direction: "download",
    status: "running",
    size: 100,
    transferred: 40,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  rows = []
  emit = null
  for (const mock of [
    pauseSftpTransfer,
    resumeSftpTransfer,
    cancelSftpTransfer,
    retrySftpTransfer,
    clearFinishedSftpTransfers,
    setSftpTransferApproval,
    requestSftpTransferApproval,
    downloadBlob,
  ]) {
    mock.mockReset()
  }
  requestSftpTransferApproval.mockResolvedValue("lease-1")
})

describe("TransferQueuePanel", () => {
  it("says there is nothing rather than rendering an empty frame", () => {
    render(<TransferQueuePanel />)
    expect(screen.getByTestId("sftp-queue-empty")).toBeInTheDocument()
  })

  /**
   * The machine's own words reach the row. An SFTP server says "Permission
   * denied" or "No space left on device", and a generic failure message throws
   * away the only part a person can act on.
   */
  it("shows the remote machine's own failure text", () => {
    rows = [
      row({
        status: "failed",
        errorCode: "sftp_operation_failed",
        errorMessage: "No space left on device",
      }),
    ]
    render(<TransferQueuePanel />)
    expect(screen.getByTestId("sftp-transfer-error-t1")).toHaveTextContent(
      "No space left on device"
    )
  })

  /**
   * A transfer waiting for approval is not a failed transfer. It gets the
   * approval control and NOT the error line, because "nobody has approved this
   * yet" is a different answer from "the machine refused you".
   */
  it("offers approval instead of an error when that is what is missing", async () => {
    rows = [
      row({
        status: "paused",
        errorCode: "sftp_approval_required",
        errorMessage: "needs approval",
      }),
    ]
    render(<TransferQueuePanel />)
    expect(screen.queryByTestId("sftp-transfer-error-t1")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(setSftpTransferApproval).toHaveBeenCalledWith("lease-1"))
    // One approval covers every parked row: it was granted for the profile and
    // the direction, not for one file.
    expect(resumeSftpTransfer).toHaveBeenCalledWith("t1")
  })

  it("does not offer resume to a row that is only waiting on approval", () => {
    rows = [row({ status: "paused", errorCode: "sftp_approval_required" })]
    render(<TransferQueuePanel />)
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument()
  })

  it("routes each control to its own action", async () => {
    rows = [row({ status: "running" })]
    render(<TransferQueuePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Pause" }))
    expect(pauseSftpTransfer).toHaveBeenCalledWith("t1")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(cancelSftpTransfer).toHaveBeenCalledWith("t1")
  })

  /**
   * The row is where the file is until it is saved, so a finished download
   * that has bytes offers to save them and one that no longer does says
   * nothing rather than offering a control that would produce an empty file.
   */
  it("offers to save a finished download, and only when the bytes are still there", async () => {
    rows = [row({ status: "done", transferred: 100, received: new Uint8Array([1, 2, 3]) })]
    render(<TransferQueuePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "app.log")

    rows = [row({ status: "done", received: undefined })]
    render(<TransferQueuePanel />)
    expect(screen.queryAllByRole("button", { name: "Save" })).toHaveLength(1)
  })

  it("a finished transfer offers no cancel", () => {
    rows = [row({ status: "done", received: new Uint8Array([1]) })]
    render(<TransferQueuePanel />)
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("clears finished rows for the profile it is showing", async () => {
    rows = [row({ status: "done" })]
    render(<TransferQueuePanel profileId="production" />)
    await userEvent.click(screen.getByTestId("sftp-queue-clear"))
    expect(clearFinishedSftpTransfers).toHaveBeenCalledWith("production")
  })

  /**
   * A live subscription is the only reason this list is trustworthy, so a row
   * that changes must reach the screen without a remount.
   */
  it("re-renders when the queue changes underneath it", async () => {
    rows = [row({ status: "running" })]
    render(<TransferQueuePanel />)
    expect(screen.getByTestId("sftp-transfer-t1")).toHaveAttribute("data-status", "running")
    act(() => emit?.([row({ status: "done", received: new Uint8Array([1]) })]))
    await waitFor(() =>
      expect(screen.getByTestId("sftp-transfer-t1")).toHaveAttribute("data-status", "done")
    )
  })
})
