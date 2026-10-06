/** @jest-environment jsdom */
import { StrictMode } from "react"
import { act, render, waitFor } from "@testing-library/react"
import { WebVitalsReporter } from "./web-vitals-reporter"
import { webVitalsStore } from "@/lib/perf/web-vitals"
import { reportWebVital } from "@/lib/telemetry/web-vitals"

const { onLCP } = jest.requireMock("next/dist/compiled/web-vitals") as { onLCP: jest.Mock }

// Exercise the actual Next hook/effect replay. Only the browser metric source
// is simulated, including the random per-registration IDs it produces.
jest.mock("next/dist/compiled/web-vitals", () => {
  let sequence = 0
  return {
    onCLS: jest.fn(),
    onFID: jest.fn(),
    onFCP: jest.fn(),
    onTTFB: jest.fn((callback) => {
      window.addEventListener(
        "pageshow",
        (event) => {
          if (event.persisted)
            callback({
              name: "TTFB",
              id: `v4-restored-${++sequence}`,
              value: 0,
              delta: 0,
              rating: "good",
              navigationType: "back-forward-cache",
              entries: [],
            })
        },
        true
      )
    }),
    onINP: jest.fn(),
    onLCP: jest.fn((callback) => {
      const id = `v4-${++sequence}`
      queueMicrotask(() =>
        callback({
          name: "LCP",
          id,
          value: 500,
          delta: 500,
          rating: "good",
          navigationType: "navigate",
          entries: [],
        })
      )
    }),
  }
})
jest.mock("@/lib/telemetry/web-vitals", () => ({ reportWebVital: jest.fn(async () => true) }))

it("coalesces StrictMode observer replays into one report without registering again on toggles", async () => {
  localStorage.clear()
  const view = render(
    <StrictMode>
      <WebVitalsReporter />
    </StrictMode>
  )
  expect(onLCP).not.toHaveBeenCalled()
  act(() => webVitalsStore.updateSettings({ enabled: true, reporting: true }))
  await waitFor(() => expect(reportWebVital).toHaveBeenCalledTimes(1))
  expect(onLCP).toHaveBeenCalledTimes(2)
  expect(webVitalsStore.getSnapshot().metrics.LCP?.id).toBe("v4-1")
  act(() => webVitalsStore.updateSettings({ enabled: false }))
  act(() => webVitalsStore.updateSettings({ enabled: true }))
  expect(onLCP).toHaveBeenCalledTimes(2)
  expect(reportWebVital).toHaveBeenCalledTimes(1)
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
  expect(webVitalsStore.getSnapshot().metrics.TTFB).toMatchObject({
    value: 0,
    navigationType: "back-forward-cache",
  })
  view.unmount()
})
