/**
 * The pane under React StrictMode (on by default in development with the App
 * Router): mount, cleanup and mount again in one commit. A pane that mounts
 * with its address already known (a chat dock page tab, ADR-0214) creates the
 * webview in the first pass, so the simulated unmount must not tear it down.
 */
import { act, renderHook } from "@testing-library/react"
import { useEffect } from "react"

import type { ElementRect } from "@/lib/browser/protocol"

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/events", () => ({ onTauriEvent: jest.fn(async () => jest.fn()) }))
let mockToken: string | null = null
const mockPendingCreates: Array<() => void> = []
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    setEmbedOwnerToken: jest.fn((token: string | null) => {
      mockToken = token
    }),
    embedCreate: jest.fn(
      () =>
        new Promise<string>((resolve) => mockPendingCreates.push(() => resolve("browser-embed")))
    ),
    embedSetBounds: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedDestroy: jest.fn().mockResolvedValue(undefined),
    // Like the real client: no owner token is a synchronous throw.
    embedSetVisible: jest.fn(() => {
      if (!mockToken) throw new Error("Embedded browser owner lease is not acquired")
      return Promise.resolve()
    }),
  },
}))
// Like the real hook: measure in a mount effect, report only a changed rect.
const mockReported = new Set<string>()
jest.mock("./use-element-rect", () => ({
  useElementRect: (_ref: unknown, onChange?: (rect: ElementRect) => void) => {
    useEffect(() => {
      const rect = { x: 0, y: 0, width: 100, height: 100 }
      if (mockReported.has("rect")) return
      mockReported.add("rect")
      onChange?.(rect)
    }, [onChange])
    return null
  },
}))

import { browserClient } from "@/lib/browser/client"
import { useBrowserPaneWebview } from "./use-browser-pane-webview"

const flush = () =>
  act(async () => {
    mockPendingCreates.splice(0).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

it("keeps the webview a pane created while StrictMode remounted it", async () => {
  const onReady = jest.fn()
  const { result, unmount } = renderHook(
    () =>
      useBrowserPaneWebview(
        { current: null },
        { url: "http://localhost:8765/", visible: false, onReady }
      ),
    { reactStrictMode: true }
  )
  await flush()

  expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)
  expect(browserClient.embedDestroy).not.toHaveBeenCalled()
  expect(result.current.owned).toBe(true)
  expect(mockToken).not.toBeNull()
  expect(onReady).toHaveBeenCalledTimes(1)
  // Parked right after creation, with the token still in place.
  expect(browserClient.embedSetVisible).toHaveBeenCalledWith(false, expect.any(Object))

  unmount()
  await flush()
  expect(browserClient.embedDestroy).toHaveBeenCalledTimes(1)
  expect(mockToken).toBeNull()
})
