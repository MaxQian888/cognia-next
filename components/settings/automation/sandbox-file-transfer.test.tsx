import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SandboxFileTransfer } from "./sandbox-file-transfer"
import { pickStreamFiles } from "@/lib/files/file-bridge"
import { saveExport } from "@/lib/files/save-export"
import { sandboxClient, MAX_SANDBOX_TRANSFER_BYTES } from "@/lib/automation/sandbox-client"

jest.mock("@/lib/files/file-bridge", () => ({ pickStreamFiles: jest.fn() }))
jest.mock("@/lib/files/save-export", () => ({ saveExport: jest.fn() }))
jest.mock("@/lib/automation/sandbox-client", () => ({
  MAX_SANDBOX_TRANSFER_BYTES: 8 * 1024 * 1024,
  sandboxClient: {
    acquireControl: jest.fn(),
    releaseControl: jest.fn(),
    uploadFile: jest.fn(),
    downloadFile: jest.fn(),
  },
}))
const picker = jest.mocked(pickStreamFiles)
const saver = jest.mocked(saveExport)
const client = jest.mocked(sandboxClient)
const release = jest.fn()
const busyChanged = jest.fn()
function panel(connectionId = "a", containerId = "container-a") {
  return (
    <SandboxFileTransfer
      connectionId={connectionId}
      containerId={containerId}
      enabled
      releaseControl={release}
      onBusyChange={busyChanged}
    />
  )
}
function picked(chunks: Uint8Array[], closed = jest.fn()) {
  return {
    name: "binary.dat",
    path: "/local/binary.dat",
    stream: async function* () {
      try {
        for (const chunk of chunks) yield chunk
      } finally {
        closed()
      }
    },
  }
}
beforeEach(() => {
  jest.resetAllMocks()
  release.mockResolvedValue(undefined)
  client.acquireControl.mockResolvedValue({ token: "fresh", expiresAt: Date.now() + 15000 })
  client.releaseControl.mockResolvedValue(undefined)
  client.uploadFile.mockResolvedValue({ path: "/home/cua/binary.dat", size: 3, sha256: "unused" })
  saver.mockResolvedValue({
    kind: "saved",
    platform: "tauri",
    location: "/save/binary.dat",
    filename: "binary.dat",
  })
})

test("uploads binary bytes to the original container with a fresh post-picker lease", async () => {
  const closed = jest.fn()
  picker.mockResolvedValue([picked([new Uint8Array([0, 255, 128])], closed)])
  render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  await screen.findByText("File uploaded to the selected sandbox.")
  expect(client.uploadFile).toHaveBeenCalledWith(
    "a",
    "container-a",
    "fresh",
    "/home/cua/binary.dat",
    "AP+A"
  )
  expect(closed).toHaveBeenCalled()
  expect(picker.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0])
  expect(release.mock.invocationCallOrder[0]).toBeLessThan(
    client.acquireControl.mock.invocationCallOrder[0]
  )
  await waitFor(() => expect(client.releaseControl).toHaveBeenCalledWith("a", "fresh"))
})

test("closes an over-limit stream before control acquisition or upload", async () => {
  const closed = jest.fn()
  picker.mockResolvedValue([
    picked([new Uint8Array(MAX_SANDBOX_TRANSFER_BYTES), new Uint8Array(1)], closed),
  ])
  render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("8 MiB")
  expect(closed).toHaveBeenCalled()
  expect(client.acquireControl).not.toHaveBeenCalled()
  expect(client.uploadFile).not.toHaveBeenCalled()
})

test.each([0, MAX_SANDBOX_TRANSFER_BYTES])(
  "accepts an exact %i byte binary upload",
  async (size) => {
    picker.mockResolvedValue([picked([new Uint8Array(size)])])
    render(panel())
    fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
    await screen.findByText("File uploaded to the selected sandbox.")
    const encoded = client.uploadFile.mock.calls[0][4]
    expect(encoded).toHaveLength(Math.ceil(size / 3) * 4)
    expect(atob(encoded)).toHaveLength(size)
  }
)

test("picker cancellation is distinguished from read failure", async () => {
  picker.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("read failed"))
  render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  await screen.findByText("File transfer cancelled.")
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to read")
  expect(client.uploadFile).not.toHaveBeenCalled()
})

test("switching targets while the picker is open never uploads to either target", async () => {
  let finish!: (files: Awaited<ReturnType<typeof pickStreamFiles>>) => void
  picker.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { rerender } = render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  rerender(panel("b", "container-b"))
  await act(async () => {
    finish([picked([new Uint8Array([1])])])
  })
  expect(client.acquireControl).not.toHaveBeenCalled()
  expect(client.uploadFile).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Choose file and upload" })).toBeEnabled()
})

test("stop and restart clears a cancelled generation's busy state", async () => {
  let finish!: (files: Awaited<ReturnType<typeof pickStreamFiles>>) => void
  picker.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { rerender } = render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  rerender(
    <SandboxFileTransfer
      connectionId="a"
      containerId="container-a"
      enabled={false}
      releaseControl={release}
      onBusyChange={busyChanged}
    />
  )
  rerender(panel())
  await act(async () => {
    finish([picked([])])
  })
  expect(client.uploadFile).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Choose file and upload" })).toBeEnabled()
})

test("an acquisition that resolves after unmount is released without uploading", async () => {
  let grant!: (lease: { token: string; expiresAt: number }) => void
  picker.mockResolvedValue([picked([])])
  client.acquireControl.mockReturnValueOnce(
    new Promise((resolve) => {
      grant = resolve
    })
  )
  const { unmount } = render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  await waitFor(() => expect(client.acquireControl).toHaveBeenCalled())
  unmount()
  await act(async () => {
    grant({ token: "late", expiresAt: Date.now() + 15000 })
  })
  expect(client.uploadFile).not.toHaveBeenCalled()
  expect(client.releaseControl).toHaveBeenCalledWith("a", "late")
})

test("a rejected upload releases its lease and allows retry", async () => {
  picker.mockResolvedValue([picked([])])
  client.uploadFile.mockRejectedValueOnce(new Error("destination exists"))
  render(panel())
  fireEvent.click(screen.getByRole("button", { name: "Choose file and upload" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed")
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Choose file and upload" })).toBeEnabled()
  )
  expect(client.releaseControl).toHaveBeenCalledWith("a", "fresh")
})

test("validates binary download size and hash before saving, and distinguishes save cancellation", async () => {
  const bytes = new Uint8Array([0, 255, 128])
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  client.downloadFile.mockResolvedValue({
    path: "/home/cua/binary.dat",
    size: 3,
    sha256: hash,
    dataBase64: "AP+A",
  })
  saver.mockResolvedValueOnce({ kind: "cancelled" })
  render(panel())
  fireEvent.change(screen.getByLabelText("File path inside the sandbox"), {
    target: { value: "/home/cua/binary.dat" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Download file" }))
  await screen.findByText("File transfer cancelled.")
  expect(client.downloadFile).toHaveBeenCalledWith("a", "container-a", "/home/cua/binary.dat")
  expect(saver).toHaveBeenCalledWith({
    filename: "binary.dat",
    data: bytes,
    mimeType: "application/octet-stream",
    shouldContinue: expect.any(Function),
  })
  expect(client.acquireControl).not.toHaveBeenCalled()
})

test("corrupt download bytes are not saved", async () => {
  client.downloadFile.mockResolvedValue({
    path: "/x",
    size: 4,
    sha256: "wrong",
    dataBase64: "AP+A",
  })
  render(panel())
  fireEvent.change(screen.getByLabelText("File path inside the sandbox"), {
    target: { value: "/x" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Download file" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("checksum")
  expect(saver).not.toHaveBeenCalled()
})

test("a download completing after target selection changes never opens a save dialog", async () => {
  let complete!: (value: Awaited<ReturnType<typeof sandboxClient.downloadFile>>) => void
  client.downloadFile.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    })
  )
  const { rerender } = render(panel())
  fireEvent.change(screen.getByLabelText("File path inside the sandbox"), {
    target: { value: "/x" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Download file" }))
  rerender(panel("b", "container-b"))
  await act(async () => {
    complete({ path: "/x", size: 0, sha256: "unused", dataBase64: "" })
  })
  expect(saver).not.toHaveBeenCalled()
})

test("missing container identity disables transfer and asks for health refresh", () => {
  render(panel("a", ""))
  expect(screen.getByRole("button", { name: "Choose file and upload" })).toBeDisabled()
  expect(screen.getByText(/Refresh the connection health/)).toBeInTheDocument()
})
