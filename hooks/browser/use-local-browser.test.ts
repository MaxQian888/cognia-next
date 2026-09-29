/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    status: jest.fn(),
    install: jest.fn(),
    uninstall: jest.fn(),
    discoverUserChrome: jest.fn(),
    onInstallProgress: jest.fn(),
  },
}))

import { localBrowser, type LocalBrowserInstallProgress } from "@/lib/browser/local-client"

import { useLocalBrowser } from "./use-local-browser"

const client = localBrowser as unknown as {
  status: jest.Mock
  install: jest.Mock
  uninstall: jest.Mock
  discoverUserChrome: jest.Mock
  onInstallProgress: jest.Mock
}

const STATUS = {
  installed: false,
  installing: false,
  chromiumVersion: null,
  running: false,
  runtimeStaged: true,
  error: null,
}

let progressListener: ((progress: LocalBrowserInstallProgress) => void) | null = null
const unlisten = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  progressListener = null
  client.status.mockResolvedValue(STATUS)
  client.discoverUserChrome.mockResolvedValue([
    {
      browser: "chrome",
      label: "Google Chrome",
      userDataDir: "/x",
      available: false,
      reason: "remote_debugging_disabled",
    },
  ])
  client.onInstallProgress.mockImplementation(async (cb) => {
    progressListener = cb
    return unlisten
  })
})

it("stays idle off the desktop", async () => {
  const { result } = renderHook(() => useLocalBrowser({ enabled: false }))
  expect(result.current.supported).toBe(false)
  await act(async () => {
    expect(await result.current.install()).toBe(false)
    expect(await result.current.uninstall()).toBe(false)
  })
  expect(client.status).not.toHaveBeenCalled()
  expect(client.onInstallProgress).not.toHaveBeenCalled()
})

it("reads status and discovers the user's browsers on mount", async () => {
  const { result, unmount } = renderHook(() => useLocalBrowser({ enabled: true }))
  await waitFor(() => expect(result.current.status).toEqual(STATUS))
  await waitFor(() => expect(result.current.userChrome).toHaveLength(1))
  unmount()
  expect(unlisten).toHaveBeenCalled()
})

it("installs, following progress events, and refreshes on done", async () => {
  client.install.mockResolvedValue({ ...STATUS, installed: true, chromiumVersion: "140" })
  const { result } = renderHook(() => useLocalBrowser({ enabled: true }))
  await waitFor(() => expect(progressListener).not.toBeNull())

  let ok = false
  await act(async () => {
    ok = await result.current.install()
  })
  expect(ok).toBe(true)
  expect(result.current.status?.installed).toBe(true)

  act(() => progressListener?.({ phase: "downloading", receivedBytes: 5, totalBytes: 10 }))
  expect(result.current.progress).toEqual({
    phase: "downloading",
    receivedBytes: 5,
    totalBytes: 10,
  })
  client.status.mockClear()
  act(() => progressListener?.({ phase: "done" }))
  await waitFor(() => expect(client.status).toHaveBeenCalled())
})

it("reports an install failure", async () => {
  client.install.mockRejectedValue(new Error("network down"))
  const { result } = renderHook(() => useLocalBrowser({ enabled: true }))
  await act(async () => {
    expect(await result.current.install()).toBe(false)
  })
  expect(result.current.error).toBe("network down")
  expect(result.current.progress).toEqual({ phase: "failed", message: "network down" })
  expect(result.current.busy).toBe(false)
})

it("treats a status carrying an error as a failed install", async () => {
  client.install.mockResolvedValue({ ...STATUS, error: "disk full" })
  const { result } = renderHook(() => useLocalBrowser({ enabled: true }))
  await act(async () => {
    expect(await result.current.install()).toBe(false)
  })
  expect(result.current.error).toBe("disk full")
})

it("uninstalls and clears progress", async () => {
  client.uninstall.mockResolvedValue(STATUS)
  const { result } = renderHook(() => useLocalBrowser({ enabled: true }))
  await act(async () => {
    expect(await result.current.uninstall()).toBe(true)
  })
  expect(result.current.progress).toBeNull()

  client.uninstall.mockRejectedValue("locked")
  await act(async () => {
    expect(await result.current.uninstall()).toBe(false)
  })
  expect(result.current.error).toBe("locked")
})

it("surfaces a failing status read", async () => {
  client.status.mockRejectedValue(new Error("no runtime"))
  const { result } = renderHook(() => useLocalBrowser({ enabled: true }))
  await waitFor(() => expect(result.current.error).toBe("no runtime"))
})
