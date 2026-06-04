/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

const notifyIfRemoteNewerMock = jest.fn(async (..._a: unknown[]) => false)
jest.mock("@/lib/webdav/remote-newer-notify", () => ({
  notifyIfRemoteNewer: (...a: unknown[]) => notifyIfRemoteNewerMock(...a),
}))

// Capture the resume / network handlers so the test can fire them manually.
let resumeHandler: (() => void) | null = null
let networkHandler: ((s: { connected: boolean }) => void) | null = null
const resumeUnsub = jest.fn()
const networkUnsub = jest.fn()

jest.mock("@/lib/capacitor/app", () => ({
  subscribeResume: async (h: () => void) => {
    resumeHandler = h
    return resumeUnsub
  },
}))
jest.mock("@/lib/capacitor/network", () => ({
  subscribe: async (h: (s: { connected: boolean }) => void) => {
    networkHandler = h
    return networkUnsub
  },
}))

import { WebDavStartupPromptProvider } from "./webdav-startup-prompt-provider"

const ORIGINAL_ENV = process.env.NODE_ENV

function setNodeEnv(value: string) {
  ;(process.env as Record<string, string>).NODE_ENV = value
}

beforeEach(() => {
  jest.useFakeTimers()
  notifyIfRemoteNewerMock.mockClear()
  resumeUnsub.mockClear()
  networkUnsub.mockClear()
  resumeHandler = null
  networkHandler = null
})

afterEach(() => {
  jest.useRealTimers()
  setNodeEnv(ORIGINAL_ENV as string)
})

describe("WebDavStartupPromptProvider", () => {
  it("renders children and skips the check in test mode", () => {
    render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
    expect(notifyIfRemoteNewerMock).not.toHaveBeenCalled()
  })

  it("runs the boot check with localized strings", async () => {
    setNodeEnv("development")
    render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    await waitFor(() => expect(notifyIfRemoteNewerMock).toHaveBeenCalledTimes(1))
    const [strings] = notifyIfRemoteNewerMock.mock.calls[0] as [{ title: string; body: string }]
    expect(typeof strings.title).toBe("string")
    expect(strings.title.length).toBeGreaterThan(0)
  })

  it("re-checks (debounced) on resume and network recovery", async () => {
    setNodeEnv("development")
    render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    await waitFor(() => expect(resumeHandler).not.toBeNull())
    notifyIfRemoteNewerMock.mockClear()

    // Burst: resume + online within the debounce window → ONE check.
    resumeHandler!()
    networkHandler!({ connected: true })
    jest.advanceTimersByTime(5_000)
    expect(notifyIfRemoteNewerMock).toHaveBeenCalledTimes(1)

    // Offline events never trigger a check.
    notifyIfRemoteNewerMock.mockClear()
    networkHandler!({ connected: false })
    jest.advanceTimersByTime(10_000)
    expect(notifyIfRemoteNewerMock).not.toHaveBeenCalled()
  })

  it("unsubscribes listeners on unmount", async () => {
    setNodeEnv("development")
    const { unmount } = render(
      <WebDavStartupPromptProvider>
        <span>child</span>
      </WebDavStartupPromptProvider>
    )
    await waitFor(() => expect(resumeHandler).not.toBeNull())
    unmount()
    expect(resumeUnsub).toHaveBeenCalled()
    expect(networkUnsub).toHaveBeenCalled()
  })
})
