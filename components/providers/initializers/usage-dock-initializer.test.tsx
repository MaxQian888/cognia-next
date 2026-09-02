/**
 * The main-window half of the dock. What matters here is that a disabled dock
 * costs nothing: no glance subscription, no window, no listeners.
 */

const openMock = jest.fn(async () => {})
const closeMock = jest.fn(async () => {})
const sendStateMock = jest.fn(async () => true)
let stateRequestHandler: (() => void) | null = null
let openFullHandler: (() => void) | null = null
const pushMock = jest.fn()
const glanceMock = jest.fn()

jest.mock("@/lib/usage-dock/client", () => ({
  openUsageDock: () => openMock(),
  closeUsageDock: () => closeMock(),
  sendUsageDockState: (...a: unknown[]) => sendStateMock(...(a as [])),
  onUsageDockStateRequest: async (h: () => void) => {
    stateRequestHandler = h
    return () => {
      stateRequestHandler = null
    }
  },
  onUsageDockOpenFull: async (h: () => void) => {
    openFullHandler = h
    return () => {
      openFullHandler = null
    }
  },
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }))
jest.mock("@/hooks/usage/use-usage-glance", () => ({
  useUsageGlance: (...a: unknown[]) => {
    glanceMock(...a)
    return {
      snapshot: { fake: true },
      loading: false,
      scanning: false,
      refresh: jest.fn(),
      sourceStates: [],
    }
  },
}))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn().mockResolvedValue(null),
  setPref: jest.fn().mockResolvedValue(undefined),
}))

import { act, render, waitFor } from "@testing-library/react"

import { USAGE_DOCK_FULL_PATH, UsageDockInitializer } from "./usage-dock-initializer"
import { __resetUsageDockStoreForTesting, useUsageDockStore } from "@/lib/usage-dock/store"

beforeEach(() => {
  __resetUsageDockStoreForTesting()
  openMock.mockClear()
  closeMock.mockClear()
  sendStateMock.mockClear()
  pushMock.mockClear()
  glanceMock.mockClear()
  stateRequestHandler = null
  openFullHandler = null
})

async function renderEnabled() {
  const view = render(<UsageDockInitializer />)
  await waitFor(() => expect(useUsageDockStore.getState().hydrated).toBe(true))
  await act(async () => {
    useUsageDockStore.getState().setPreferences({ enabled: true })
  })
  return view
}

describe("UsageDockInitializer", () => {
  it("renders nothing", async () => {
    const { container } = render(<UsageDockInitializer />)
    await waitFor(() => expect(useUsageDockStore.getState().hydrated).toBe(true))
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps the glance feed off while the dock is disabled", async () => {
    render(<UsageDockInitializer />)
    await waitFor(() => expect(useUsageDockStore.getState().hydrated).toBe(true))
    expect(glanceMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })

  it("closes the window while disabled", async () => {
    render(<UsageDockInitializer />)
    await waitFor(() => expect(closeMock).toHaveBeenCalled())
    expect(openMock).not.toHaveBeenCalled()
  })

  it("opens the window and turns on the feed once enabled", async () => {
    await renderEnabled()
    await waitFor(() => expect(openMock).toHaveBeenCalled())
    expect(glanceMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it("opens the window at boot when the persisted preference says enabled", async () => {
    // Visibility has exactly one source of truth. Rust persists the dock's
    // geometry but deliberately not whether it shows, so there is no second
    // "restore" answer that can disagree with this one.
    render(<UsageDockInitializer />)
    await act(async () => {
      useUsageDockStore.setState({
        preferences: { ...useUsageDockStore.getState().preferences, enabled: true },
        hydrated: true,
      })
    })
    await waitFor(() => expect(openMock).toHaveBeenCalled())
  })

  it("pushes the projection to the dock window", async () => {
    await renderEnabled()
    await waitFor(() =>
      expect(sendStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ glance: { fake: true } })
      )
    )
  })

  it("seeds a dock that just mounted and asked", async () => {
    await renderEnabled()
    await waitFor(() => expect(stateRequestHandler).not.toBeNull())
    sendStateMock.mockClear()
    await act(async () => stateRequestHandler?.())
    expect(sendStateMock).toHaveBeenCalled()
  })

  it("navigates the main window when the dock asks, because the dock cannot", async () => {
    await renderEnabled()
    await waitFor(() => expect(openFullHandler).not.toBeNull())
    await act(async () => openFullHandler?.())
    expect(pushMock).toHaveBeenCalledWith(USAGE_DOCK_FULL_PATH)
  })

  it("installs no listeners while the dock is disabled", async () => {
    render(<UsageDockInitializer />)
    await waitFor(() => expect(useUsageDockStore.getState().hydrated).toBe(true))
    expect(stateRequestHandler).toBeNull()
    expect(openFullHandler).toBeNull()
  })

  it("reads spend for today in the Cognia scope", async () => {
    // The dock does not get its own scope control. Its rail is provider
    // gauges, and external spend belongs to another tool's bill.
    await renderEnabled()
    expect(glanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { period: "today", scope: "cognia", metric: "spend" },
      })
    )
  })
})
