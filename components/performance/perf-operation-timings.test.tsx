/** @jest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require("../../i18n/messages/en/performance.json").operations
    return (key: string, values?: Record<string, string | number>) => {
      const value = key.split(".").reduce((current, part) => current?.[part], messages)
      if (typeof value !== "string") throw new Error(`Missing translation: ${key}`)
      return Object.entries(values ?? {}).reduce(
        (text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)),
        value
      )
    }
  },
}))

const mockUpdate = jest.fn()
const mockClear = jest.fn()
const mockDisconnect = jest.fn()
let mockSnapshot = {
  settings: {
    enabled: false,
    groups: { startup: true, storage: true, transport: true, network: true },
  },
  rows: [] as Array<{
    name: string
    group: string
    count: number
    errors: number
    cancelled: number
    inFlight: number
    samples: number
    p50Ms: number | null
    p95Ms: number | null
    maxMs: number | null
    lastMs: number | null
  }>,
  dropped: 0,
  persistenceError: false,
}
const mockRecorder = {
  subscribe: () => () => {},
  getSnapshot: () => mockSnapshot,
  getServerSnapshot: () => mockSnapshot,
  connect: () => mockDisconnect,
  updateSettings: mockUpdate,
  clear: mockClear,
}
jest.mock("@/lib/perf/operation-performance", () => ({
  OPERATION_GROUPS: ["startup", "storage", "transport", "network"],
  getOperationPerformanceRecorder: () => mockRecorder,
}))

import { PerfOperationTimings } from "./perf-operation-timings"

beforeEach(() => {
  jest.clearAllMocks()
  mockSnapshot = {
    settings: {
      enabled: false,
      groups: { startup: true, storage: true, transport: true, network: true },
    },
    rows: [],
    dropped: 0,
    persistenceError: false,
  }
})

it("is default-off and independently controls the four groups", () => {
  const view = render(<PerfOperationTimings />)
  expect(screen.getByRole("switch", { name: "Collect application operations" })).not.toBeChecked()
  expect(screen.getByRole("switch", { name: "Storage" })).toBeDisabled()
  fireEvent.click(screen.getByRole("switch", { name: "Collect application operations" }))
  expect(mockUpdate).toHaveBeenCalledWith({ enabled: true })
  mockSnapshot = { ...mockSnapshot, settings: { ...mockSnapshot.settings, enabled: true } }
  view.rerender(<PerfOperationTimings />)
  for (const group of ["Startup", "Storage", "Host calls", "Network"])
    fireEvent.click(screen.getByRole("switch", { name: group }))
  expect(mockUpdate).toHaveBeenCalledWith({ groups: { storage: false } })
  expect(mockUpdate).toHaveBeenCalledWith({ groups: { transport: false } })
  view.unmount()
  expect(mockDisconnect).toHaveBeenCalledTimes(1)
})

it("shows operation outcomes, bounded sample count and measured zero", () => {
  mockSnapshot.settings.enabled = true
  mockSnapshot.rows = [
    {
      name: "storage.messages.load",
      group: "storage",
      count: 180,
      errors: 2,
      cancelled: 1,
      inFlight: 3,
      samples: 120,
      p50Ms: 0,
      p95Ms: 80,
      maxMs: 110,
      lastMs: 4,
    },
  ]
  render(<PerfOperationTimings />)
  const table = screen.getByRole("table")
  expect(within(table).getByText("Load chat history")).toBeInTheDocument()
  expect(within(table).getByText("180")).toBeInTheDocument()
  expect(within(table).getByText("120")).toBeInTheDocument()
  expect(within(table).getByText("0 ms")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Clear operation statistics" }))
  expect(mockClear).toHaveBeenCalledTimes(1)
})

it("never displays stale measurements for an opted-out group or master", () => {
  mockSnapshot.rows = [
    {
      name: "network.browser.fetch",
      group: "network",
      count: 1,
      errors: 0,
      cancelled: 0,
      inFlight: 0,
      samples: 1,
      p50Ms: 12,
      p95Ms: 12,
      maxMs: 12,
      lastMs: 12,
    },
  ]
  const view = render(<PerfOperationTimings />)
  expect(screen.queryByRole("table")).not.toBeInTheDocument()
  mockSnapshot = {
    ...mockSnapshot,
    settings: { enabled: true, groups: { ...mockSnapshot.settings.groups, network: false } },
  }
  view.rerender(<PerfOperationTimings />)
  expect(screen.queryByRole("table")).not.toBeInTheDocument()
})

it("explains dropped measurements and persistence failures without blocking controls", () => {
  mockSnapshot.dropped = 7
  mockSnapshot.persistenceError = true
  render(<PerfOperationTimings />)
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved")
  expect(screen.getByText(/7 operations were not recorded/)).toBeInTheDocument()
  expect(screen.getByRole("switch", { name: "Collect application operations" })).toBeEnabled()
})
