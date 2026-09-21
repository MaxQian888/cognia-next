import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AttachmentSourceActions } from "./attachment-source-actions"
import { getSessionAsset, deleteSessionAsset } from "@/lib/db/session-assets"
import { downloadBlob } from "@/lib/files/download"

let mockAsset: { assetId: string; sourceAvailable: boolean } | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({ asset: mockAsset, failed: false }),
}))
jest.mock("@/lib/db/session-assets", () => ({
  getSessionAssetMetadata: jest.fn(),
  getSessionAsset: jest.fn(),
  deleteSessionAsset: jest.fn(),
}))
jest.mock("@/lib/files/download", () => ({ downloadBlob: jest.fn() }))

beforeEach(() => {
  jest.clearAllMocks()
  mockAsset = { assetId: "asset", sourceAvailable: true }
})

it("downloads the exact original through its owning session", async () => {
  const blob = new Blob(["original bytes"])
  jest
    .mocked(getSessionAsset)
    .mockResolvedValue({ blob, filename: "report.pdf" } as Awaited<
      ReturnType<typeof getSessionAsset>
    >)
  render(<AttachmentSourceActions sessionId="session" assetId="asset" />)
  fireEvent.click(screen.getByRole("button", { name: "Download original" }))
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(blob, "report.pdf"))
  expect(getSessionAsset).toHaveBeenCalledWith("session", "asset")
})

it("keeps derived-only sources removable without offering a false download", () => {
  mockAsset = { assetId: "asset", sourceAvailable: false }
  render(<AttachmentSourceActions sessionId="session" assetId="asset" />)
  expect(screen.getByText("Original unavailable on this device")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Download original" })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Remove source" })).toBeEnabled()
})

it("removes only after confirmation and reports a failed deletion without hiding the source", async () => {
  jest
    .mocked(deleteSessionAsset)
    .mockRejectedValueOnce(new Error("quota"))
    .mockResolvedValueOnce(undefined)
  render(<AttachmentSourceActions sessionId="session" assetId="asset" />)
  fireEvent.click(screen.getByRole("button", { name: "Remove source" }))
  expect(deleteSessionAsset).not.toHaveBeenCalled()
  const dialog = screen.getByRole("alertdialog")
  fireEvent.click(dialog.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')!)
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unable to access"))
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  fireEvent.click(dialog.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')!)
  await waitFor(() => expect(screen.getByText("Source removed")).toBeInTheDocument())
  expect(deleteSessionAsset).toHaveBeenLastCalledWith("session", "asset")
})

it("handles an original disappearing between metadata lookup and download", async () => {
  jest.mocked(getSessionAsset).mockResolvedValue(undefined)
  render(<AttachmentSourceActions sessionId="session" assetId="asset" />)
  fireEvent.click(screen.getByRole("button", { name: "Download original" }))
  await waitFor(() =>
    expect(screen.getByText("Original unavailable on this device")).toBeInTheDocument()
  )
  expect(downloadBlob).not.toHaveBeenCalled()
})
