/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

const maybeAutoUploadNowMock = jest.fn(async (..._a: unknown[]) => ({
  ran: false,
  reason: "disabled",
}))
jest.mock("@/lib/webdav/auto-upload", () => ({
  maybeAutoUploadNow: (...a: unknown[]) => maybeAutoUploadNowMock(...a),
}))

let platformValue = "web"
jest.mock("@/components/mobile/pair/pair-helpers", () => ({
  getDevicePlatform: () => platformValue,
}))

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

import { WebDavMobileAutosyncProvider } from "./webdav-mobile-autosync-provider"

const ORIGINAL_ENV = process.env.NODE_ENV

function setNodeEnv(value: string) {
  ;(process.env as Record<string, string>).NODE_ENV = value
}

beforeEach(() => {
  jest.useFakeTimers()
  maybeAutoUploadNowMock.mockClear()
  resumeUnsub.mockClear()
  networkUnsub.mockClear()
  resumeHandler = null
  networkHandler = null
  platformValue = "web"
})

afterEach(() => {
  jest.useRealTimers()
  setNodeEnv(ORIGINAL_ENV as string)
})

describe("WebDavMobileAutosyncProvider", () => {
  it("renders children and no-ops in test mode", () => {
    render(
      <WebDavMobileAutosyncProvider>
        <span>child</span>
      </WebDavMobileAutosyncProvider>
    )
    expect(screen.getByText("child")).toBeInTheDocument()
    jest.advanceTimersByTime(60_000)
    expect(maybeAutoUploadNowMock).not.toHaveBeenCalled()
  })

  it("no-ops on non-Capacitor platforms", () => {
    setNodeEnv("development")
    platformValue = "web"
    render(
      <WebDavMobileAutosyncProvider>
        <span>child</span>
      </WebDavMobileAutosyncProvider>
    )
    jest.advanceTimersByTime(60_000)
    expect(maybeAutoUploadNowMock).not.toHaveBeenCalled()
    expect(resumeHandler).toBeNull()
  })

  it("fires a debounced boot attempt on Capacitor", () => {
    setNodeEnv("development")
    platformValue = "android"
    render(
      <WebDavMobileAutosyncProvider>
        <span>child</span>
      </WebDavMobileAutosyncProvider>
    )
    expect(maybeAutoUploadNowMock).not.toHaveBeenCalled()
    jest.advanceTimersByTime(5_000)
    expect(maybeAutoUploadNowMock).toHaveBeenCalledTimes(1)
  })

  it("collapses resume + online bursts into one upload attempt", async () => {
    setNodeEnv("development")
    platformValue = "ios"
    render(
      <WebDavMobileAutosyncProvider>
        <span>child</span>
      </WebDavMobileAutosyncProvider>
    )
    jest.advanceTimersByTime(5_000) // flush the boot attempt
    await waitFor(() => expect(resumeHandler).not.toBeNull())
    maybeAutoUploadNowMock.mockClear()

    resumeHandler!()
    networkHandler!({ connected: true })
    resumeHandler!()
    jest.advanceTimersByTime(5_000)
    expect(maybeAutoUploadNowMock).toHaveBeenCalledTimes(1)

    // Going offline never triggers.
    maybeAutoUploadNowMock.mockClear()
    networkHandler!({ connected: false })
    jest.advanceTimersByTime(10_000)
    expect(maybeAutoUploadNowMock).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", async () => {
    setNodeEnv("development")
    platformValue = "android"
    const { unmount } = render(
      <WebDavMobileAutosyncProvider>
        <span>child</span>
      </WebDavMobileAutosyncProvider>
    )
    await waitFor(() => expect(resumeHandler).not.toBeNull())
    unmount()
    expect(resumeUnsub).toHaveBeenCalled()
    expect(networkUnsub).toHaveBeenCalled()
  })
})
