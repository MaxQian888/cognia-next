/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"
import { WebVitalsReporter } from "./web-vitals-reporter"
import { webVitalsStore } from "@/lib/perf/web-vitals"

jest.mock("next/web-vitals", () => ({ useReportWebVitals: jest.fn() }))
import { useReportWebVitals } from "next/web-vitals"

it("does not register until enabled, and keeps the callback mounted while controls change", () => {
  localStorage.clear()
  const view = render(<WebVitalsReporter />)
  expect(useReportWebVitals).not.toHaveBeenCalled()
  act(() => webVitalsStore.updateSettings({ enabled: true }))
  expect(useReportWebVitals).toHaveBeenCalledWith(webVitalsStore.ingest)
  const callback = jest.mocked(useReportWebVitals).mock.calls[0][0]
  act(() => webVitalsStore.updateSettings({ enabled: false }))
  act(() =>
    callback({
      name: "LCP",
      id: "v4-1-2",
      value: 10,
      delta: 10,
      rating: "good",
      navigationType: "navigate",
      entries: [],
    })
  )
  expect(webVitalsStore.getSnapshot().metrics).toEqual({})
  act(() => webVitalsStore.updateSettings({ enabled: true }))
  for (const [fn] of jest.mocked(useReportWebVitals).mock.calls) expect(fn).toBe(callback)
  view.unmount()
})

it("isolates observer initialization failures from the application", () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {})
  jest.mocked(useReportWebVitals).mockImplementation(() => {
    throw new Error("observer unavailable")
  })
  try {
    const view = render(
      <>
        <WebVitalsReporter />
        <main>Application remains available</main>
      </>
    )
    expect(view.getByRole("main")).toHaveTextContent("Application remains available")
    expect(webVitalsStore.getSnapshot().error).toBe(true)
    view.unmount()
  } finally {
    error.mockRestore()
    jest.mocked(useReportWebVitals).mockReset()
  }
})
