/** @jest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    // Read the split source so this suite also checks newly added translation keys.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require("../../i18n/messages/en/performance.json").webVitals
    return (key: string, values?: Record<string, string | number>) => {
      const value = key.split(".").reduce((current, part) => current?.[part], messages)
      if (typeof value !== "string") throw new Error(`Missing Web Vitals translation: ${key}`)
      return Object.entries(values ?? {}).reduce(
        (text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)),
        value
      )
    }
  },
}))

const mockUpdate = jest.fn()
const mockClear = jest.fn()
let mockSnapshot: {
  settings: { enabled: boolean; reporting: boolean; metrics: Record<string, boolean> }
  metrics: Record<string, { name: string; value: number; rating: string }>
  supported: string[] | null
  started: boolean
  error: boolean
  persistenceError: boolean
}
jest.mock("@/lib/perf/web-vitals", () => ({
  WEB_VITAL_NAMES: ["LCP", "INP", "CLS", "FCP", "TTFB", "FID"],
  webVitalsStore: {
    subscribe: () => () => {},
    getSnapshot: () => mockSnapshot,
    getServerSnapshot: () => mockSnapshot,
    updateSettings: (patch: unknown) => mockUpdate(patch),
    clear: () => mockClear(),
  },
}))

import { PerfWebVitalsPanel } from "./perf-web-vitals-panel"

beforeEach(() => {
  mockUpdate.mockClear()
  mockClear.mockClear()
  mockSnapshot = {
    settings: {
      enabled: false,
      reporting: false,
      metrics: { LCP: true, INP: true, CLS: true, FCP: true, TTFB: true, FID: false },
    },
    metrics: {},
    supported: null,
    started: false,
    error: false,
    persistenceError: false,
  }
})

it("keeps reporting and metric controls disabled until collection is enabled", () => {
  render(<PerfWebVitalsPanel />)
  expect(screen.getByRole("switch", { name: "Report through telemetry" })).toBeDisabled()
  expect(screen.getByRole("switch", { name: "Collect LCP" })).toBeDisabled()
  expect(screen.getAllByText("Off")).toHaveLength(6)
  fireEvent.click(screen.getByRole("switch", { name: "Collect Web Vitals" }))
  expect(mockUpdate).toHaveBeenCalledWith({ enabled: true })
})

it("toggles reporting independently and preserves every other metric preference", () => {
  mockSnapshot.settings.enabled = true
  render(<PerfWebVitalsPanel />)
  fireEvent.click(screen.getByRole("switch", { name: "Report through telemetry" }))
  expect(mockUpdate).toHaveBeenCalledWith({ reporting: true })
  fireEvent.click(screen.getByRole("switch", { name: "Collect INP" }))
  expect(mockUpdate).toHaveBeenCalledWith({
    metrics: { LCP: true, INP: false, CLS: true, FCP: true, TTFB: true, FID: false },
  })
  fireEvent.click(screen.getByRole("switch", { name: "Collect Web Vitals" }))
  expect(mockUpdate).toHaveBeenLastCalledWith({ enabled: false })
})

it("distinguishes pending, unsupported and individually disabled metrics", () => {
  mockSnapshot.settings.enabled = true
  mockSnapshot.started = true
  mockSnapshot.supported = ["LCP", "FCP", "TTFB"]
  render(<PerfWebVitalsPanel />)
  expect(
    within(screen.getByRole("group", { name: "LCP" })).getByText("Waiting for a measurement")
  ).toBeInTheDocument()
  expect(
    within(screen.getByRole("group", { name: "INP" })).getByText("Unsupported in this runtime")
  ).toBeInTheDocument()
  expect(within(screen.getByRole("group", { name: "FID" })).getByText("Off")).toBeInTheDocument()
})

it("shows a loading error instead of misleading pending values", () => {
  mockSnapshot.settings.enabled = true
  mockSnapshot.error = true
  render(<PerfWebVitalsPanel />)
  expect(screen.getByRole("alert")).toHaveTextContent("Could not start Web Vitals collection")
  expect(screen.getAllByText("Collection unavailable")).toHaveLength(5)
})

it("explains unsaved preferences while keeping collection off immediately", () => {
  mockSnapshot.persistenceError = true
  render(<PerfWebVitalsPanel />)
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved for your next visit")
  expect(screen.getByRole("switch", { name: "Collect Web Vitals" })).not.toBeChecked()
  expect(screen.getByRole("switch", { name: "Report through telemetry" })).toBeDisabled()
  expect(screen.getAllByText("Off")).toHaveLength(6)
})

it("shows dimensionless CLS and timing values in milliseconds with ratings", () => {
  mockSnapshot.settings.enabled = true
  mockSnapshot.metrics = {
    CLS: { name: "CLS", value: 0.1234, rating: "needs-improvement" },
    LCP: { name: "LCP", value: 1234.56, rating: "good" },
  }
  render(<PerfWebVitalsPanel />)
  expect(within(screen.getByRole("group", { name: "CLS" })).getByText("0.123")).toBeInTheDocument()
  expect(
    within(screen.getByRole("group", { name: "CLS" })).getByText("Needs improvement")
  ).toBeInTheDocument()
  expect(
    within(screen.getByRole("group", { name: "LCP" })).getByText("1235 ms")
  ).toBeInTheDocument()
})

it("clears retained values without changing preferences", () => {
  mockSnapshot.metrics = { CLS: { name: "CLS", value: 0.12, rating: "good" } }
  render(<PerfWebVitalsPanel />)
  fireEvent.click(screen.getByRole("button", { name: "Clear Web Vitals" }))
  expect(mockClear).toHaveBeenCalledTimes(1)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it("disables clearing an empty session and links to actual telemetry settings", () => {
  render(<PerfWebVitalsPanel />)
  expect(screen.getByRole("button", { name: "Clear Web Vitals" })).toBeDisabled()
  expect(screen.getByRole("link", { name: "Telemetry settings" })).toHaveAttribute(
    "href",
    "/me/logs?logsPanel=telemetry"
  )
  expect(screen.getByText(/Reload to begin a fresh measurement session/)).toBeInTheDocument()
})
