/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: jest.fn() }))

let progressCb: ((p: { stage: string; bytesDone: number; bytesTotal: number }) => void) | undefined
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (_name: string, cb: typeof progressCb) => {
    progressCb = cb
    return Promise.resolve(() => {})
  },
}))
jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: { downloadProgress: "codeserver://download-progress" },
  codeServerClient: {
    supported: jest.fn(),
    diskUsage: jest.fn(),
    download: jest.fn(),
    cancelDownload: jest.fn(),
    uninstall: jest.fn(),
    status: jest.fn(),
  },
}))
let mockActiveRoot: string | null = null
jest.mock("@/lib/codeserver/pane-manager", () => ({
  destroyCodeServerPane: jest.fn().mockResolvedValue(undefined),
  getActiveProIdeRoot: () => mockActiveRoot,
}))

// "Can this card manage an install from here". Desktop by default; the phone
// and standalone-browser branches are exercised on their own below.
let mockReach: { available: boolean; block?: string; remedy?: string | null } = {
  available: true,
}
jest.mock("@/hooks/platform/use-surface-reach", () => ({
  useSurfaceReach: () => mockReach,
}))

import { type CodeServerInstallInfo, codeServerClient } from "@/lib/codeserver/client"
import { destroyCodeServerPane } from "@/lib/codeserver/pane-manager"
import { toast } from "sonner"
import { ProIdeSection } from "./pro-ide-section"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>
const destroyPane = destroyCodeServerPane as jest.Mock
const toasts = toast as unknown as { success: jest.Mock; error: jest.Mock; info: jest.Mock }

const USAGE = {
  version: "4.128.0",
  root: "/data/cognia/code-server",
  installed: true,
  totalBytes: 300 * 1024 * 1024,
  reclaimableBytes: 120 * 1024 * 1024,
  staleVersions: ["4.100.0"],
}

beforeEach(() => {
  mockIsTauri = true
  mockReach = { available: true }
  mockActiveRoot = null
  progressCb = undefined
  client.status.mockReset().mockResolvedValue({
    running: false,
    port: null,
    version: "4.128.0",
  })
  client.supported.mockReset().mockResolvedValue(true)
  client.diskUsage.mockReset().mockResolvedValue(USAGE)
  client.download.mockReset().mockResolvedValue({
    version: "4.128.0",
    installDir: "/d",
    binaryPath: "/d/bin/code-server",
  })
  client.uninstall.mockReset().mockResolvedValue(120 * 1024 * 1024)
  client.cancelDownload.mockReset().mockResolvedValue(undefined)
  destroyPane.mockClear()
  toasts.success.mockReset()
  toasts.error.mockReset()
  toasts.info.mockReset()
})

it("explains that the platform has no code-server build", async () => {
  client.supported.mockResolvedValue(false)
  render(<ProIdeSection />)

  expect(await screen.findByTestId("pro-ide-unsupported")).toBeInTheDocument()
  expect(client.diskUsage).not.toHaveBeenCalled()
})

it("treats a non-desktop shell as unsupported without probing", async () => {
  mockIsTauri = false
  render(<ProIdeSection />)

  expect(await screen.findByTestId("pro-ide-unsupported")).toBeInTheDocument()
  expect(client.supported).not.toHaveBeenCalled()
})

it("shows the pinned version, footprint and reclaimable space", async () => {
  render(<ProIdeSection />)

  // The card renders placeholders first, so wait for the loaded value rather
  // than for the element to exist.
  await waitFor(() => expect(screen.getByTestId("pro-ide-version")).toHaveTextContent("4.128.0"))
  expect(screen.getByTestId("pro-ide-installed")).toHaveTextContent("installed")
  expect(screen.getByTestId("pro-ide-total")).toHaveTextContent("300")
  expect(screen.getByTestId("pro-ide-reclaimable")).toHaveTextContent("120")
  expect(screen.getByTestId("pro-ide-root")).toHaveTextContent("/data/cognia/code-server")
})

it("offers pre-fetch only while nothing is installed", async () => {
  client.diskUsage.mockResolvedValue({ ...USAGE, installed: false, reclaimableBytes: 0 })
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-download")).toBeEnabled())
  // Nothing to reclaim and nothing installed → both cleanup actions are off.
  expect(screen.getByTestId("pro-ide-clean")).toBeDisabled()
  expect(screen.getByTestId("pro-ide-uninstall")).toBeDisabled()

  fireEvent.click(screen.getByTestId("pro-ide-download"))
  await waitFor(() => expect(client.download).toHaveBeenCalled())
  expect(toasts.success).toHaveBeenCalledWith("downloadDone")
})

it("renders a real progress bar during the pre-fetch", async () => {
  const install = { version: "4.128.0", installDir: "/d", binaryPath: "/d/bin/code-server" }
  let finish: (v: typeof install) => void = () => {}
  client.download.mockReturnValue(
    new Promise<typeof install>((resolve) => {
      finish = resolve
    })
  )
  client.diskUsage.mockResolvedValue({ ...USAGE, installed: false })
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-download")).toBeEnabled())
  fireEvent.click(screen.getByTestId("pro-ide-download"))
  act(() => progressCb?.({ stage: "downloading", bytesDone: 50, bytesTotal: 100 }))

  expect(await screen.findByTestId("pro-ide-progress")).toBeInTheDocument()

  finish(install)
  await waitFor(() => expect(screen.queryByTestId("pro-ide-progress")).not.toBeInTheDocument())
})

it("cleans stale versions without touching the pinned install", async () => {
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-clean")).toBeEnabled())
  fireEvent.click(screen.getByTestId("pro-ide-clean"))

  await waitFor(() => expect(client.uninstall).toHaveBeenCalledWith(false))
  expect(toasts.success).toHaveBeenCalledWith("cleanDone")
})

it("confirms before a full uninstall, then removes everything", async () => {
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-uninstall")).toBeEnabled())
  fireEvent.click(screen.getByTestId("pro-ide-uninstall"))
  expect(await screen.findByTestId("pro-ide-uninstall-dialog")).toBeInTheDocument()
  expect(client.uninstall).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId("pro-ide-uninstall-confirm"))
  await waitFor(() => expect(client.uninstall).toHaveBeenCalledWith(true))
})

it("tears the native pane down before reclaiming disk", async () => {
  // Both modes stop every running instance backend-side, so a surviving webview
  // would be left pinned over the app showing a dead page.
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-clean")).toBeEnabled())
  fireEvent.click(screen.getByTestId("pro-ide-clean"))
  await waitFor(() => expect(client.uninstall).toHaveBeenCalledWith(false))
  expect(destroyPane).toHaveBeenCalledTimes(1)
  expect(destroyPane.mock.invocationCallOrder[0]).toBeLessThan(
    client.uninstall.mock.invocationCallOrder[0]
  )

  fireEvent.click(screen.getByTestId("pro-ide-uninstall"))
  fireEvent.click(await screen.findByTestId("pro-ide-uninstall-confirm"))

  await waitFor(() => expect(client.uninstall).toHaveBeenCalledWith(true))
  expect(destroyPane).toHaveBeenCalledTimes(2)
})

it("surfaces failures as a toast and refreshes anyway", async () => {
  client.uninstall.mockRejectedValueOnce(new Error("permission denied"))
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-clean")).toBeEnabled())
  client.diskUsage.mockClear()
  fireEvent.click(screen.getByTestId("pro-ide-clean"))

  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("failed"))
  expect(client.diskUsage).toHaveBeenCalled()
})

it("degrades to placeholders when the disk probe fails", async () => {
  client.diskUsage.mockRejectedValue(new Error("no app data dir"))
  render(<ProIdeSection />)

  expect(await screen.findByTestId("pro-ide-version")).toHaveTextContent("—")
  expect(screen.getByTestId("pro-ide-clean")).toBeDisabled()
})

it("offers a way out of the pre-fetch and reports the cancel as a cancel", async () => {
  // The pre-fetch is ~100-200MB. Before this the card committed the user to the
  // whole transfer on a single mis-click, while the editor pane had a cancel.
  let fail: (cause: unknown) => void = () => {}
  client.download.mockReturnValue(
    new Promise<CodeServerInstallInfo>((_resolve, reject) => {
      fail = reject
    })
  )
  client.diskUsage.mockResolvedValue({ ...USAGE, installed: false })
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-download")).toBeEnabled())
  expect(screen.queryByTestId("pro-ide-cancel-download")).not.toBeInTheDocument()

  fireEvent.click(screen.getByTestId("pro-ide-download"))
  fireEvent.click(await screen.findByTestId("pro-ide-cancel-download"))
  expect(client.cancelDownload).toHaveBeenCalledTimes(1)

  // The backend drops the streaming future, so the in-flight download rejects.
  // That rejection is the user's own cancel, not a failure.
  fail(new Error("download cancelled"))
  await waitFor(() => expect(toasts.info).toHaveBeenCalledWith("downloadCancelled"))
  expect(toasts.error).not.toHaveBeenCalled()
  expect(screen.queryByTestId("pro-ide-cancel-download")).not.toBeInTheDocument()
})

it("keeps reporting a genuine pre-fetch failure as a failure", async () => {
  client.download.mockRejectedValueOnce(new Error("checksum mismatch"))
  client.diskUsage.mockResolvedValue({ ...USAGE, installed: false })
  render(<ProIdeSection />)

  await waitFor(() => expect(screen.getByTestId("pro-ide-download")).toBeEnabled())
  fireEvent.click(screen.getByTestId("pro-ide-download"))

  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("failed"))
  expect(toasts.info).not.toHaveBeenCalled()
})

describe("reach", () => {
  it("explains itself on a companion instead of saying 'unsupported'", () => {
    // The old branch printed one sentence whether the user was on Windows, on a
    // phone, or in a browser with nothing paired. Those are three situations
    // with three different next steps.
    mockReach = { available: false, block: "needs-desktop-shell", remedy: null }
    render(<ProIdeSection />)
    expect(screen.getByTestId("pro-ide-unsupported")).toBeInTheDocument()
    expect(screen.getByTestId("surface-unavailable-notice")).toHaveAttribute(
      "data-cause",
      "needs-desktop-shell"
    )
  })

  it("names a different cause for a standalone browser", () => {
    mockReach = { available: false, block: "no-host", remedy: "/pair" }
    render(<ProIdeSection />)
    expect(screen.getByTestId("surface-unavailable-notice")).toHaveAttribute(
      "data-cause",
      "no-host"
    )
  })

  it("keeps the platform message for a desktop with no prebuilt binary", () => {
    // Reachable and still impossible: this IS the desktop, and code-server has
    // no build for its platform or architecture.
    client.supported.mockResolvedValue(false)
    render(<ProIdeSection />)
    return waitFor(() => {
      expect(screen.getByTestId("pro-ide-unsupported")).toBeInTheDocument()
      expect(screen.queryByTestId("surface-unavailable-notice")).not.toBeInTheDocument()
    })
  })
})

describe("running state", () => {
  it("reports no running workbench when nothing has been claimed", async () => {
    render(<ProIdeSection />)
    await waitFor(() => expect(screen.getByTestId("pro-ide-running")).toBeInTheDocument())
    expect(screen.getByTestId("pro-ide-running")).toHaveTextContent("runningNone")
    expect(client.status).not.toHaveBeenCalled()
  })

  it("names the workspace the bound instance is serving", async () => {
    // `codeserver_status` had no production caller at all, which is the one
    // entry from ADR-0088's own "zero callers" list that was never closed.
    mockActiveRoot = "/work/repo"
    client.status.mockResolvedValue({ running: true, port: 41234, version: "4.128.0" })
    render(<ProIdeSection />)
    await waitFor(() => expect(client.status).toHaveBeenCalledWith("/work/repo"))
    expect(screen.getByTestId("pro-ide-running")).toHaveTextContent("runningFor")
  })

  it("treats a status probe failure as 'not running' rather than crashing", async () => {
    mockActiveRoot = "/work/repo"
    client.status.mockRejectedValue(new Error("instance exited"))
    render(<ProIdeSection />)
    await waitFor(() => expect(client.status).toHaveBeenCalled())
    expect(screen.getByTestId("pro-ide-running")).toHaveTextContent("runningNone")
  })
})
