import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BatchExportDialog } from "./batch-export-dialog"

const runMock = jest.fn()
jest.mock("@/hooks/data/use-batch-export", () => ({
  useBatchExport: () => ({ run: runMock, busy: false, progress: null }),
}))

const notifyMock = jest.fn()
jest.mock("@/lib/files/export-feedback", () => ({
  notifyExportOutcome: (...a: unknown[]) => notifyMock(...a),
}))

const listSessionsMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => listSessionsMock(),
}))

beforeEach(() => {
  runMock.mockReset()
  notifyMock.mockReset()
  listSessionsMock.mockReset().mockResolvedValue([
    { id: "s1", title: "First" },
    { id: "s2", title: "Second" },
  ])
})

async function openDialog() {
  const user = userEvent.setup()
  render(<BatchExportDialog trigger={<button>open</button>} />)
  await user.click(screen.getByText("open"))
  // Sessions load (default: all selected).
  await screen.findByText("First")
  return user
}

describe("BatchExportDialog", () => {
  it("exports the selected sessions and routes feedback through notifyExportOutcome", async () => {
    const outcome = {
      kind: "saved" as const,
      platform: "web" as const,
      location: "downloads",
      filename: "cognia-export.zip",
    }
    runMock.mockResolvedValue({ outcome, exportedCount: 2 })

    const user = await openDialog()
    await user.click(screen.getByRole("button", { name: "Export ZIP" }))

    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1))
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: expect.arrayContaining([expect.objectContaining({ id: "s1" })]),
      })
    )
    expect(notifyMock).toHaveBeenCalledWith(
      outcome,
      expect.objectContaining({ t: expect.any(Function) })
    )
  })

  it("still notifies on an error outcome", async () => {
    const outcome = { kind: "error" as const, message: "boom" }
    runMock.mockResolvedValue({ outcome, exportedCount: 0 })

    const user = await openDialog()
    await user.click(screen.getByRole("button", { name: "Export ZIP" }))

    await waitFor(() => expect(notifyMock).toHaveBeenCalledWith(outcome, expect.anything()))
  })
})
