/** @jest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require("../../i18n/messages/en/performance.json").browserDiagnostics
    return (key: string, values?: Record<string, string | number>) => {
      const value = key.split(".").reduce((current, part) => current?.[part], messages)
      if (typeof value !== "string") throw new Error(`Missing diagnostics translation: ${key}`)
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
const mockConnect = jest.fn(() => mockDisconnect)
type Group = "resources" | "interactions" | "navigation" | "frames"
let mockSnapshot: {
  settings: Record<Group | "enabled", boolean>
  supported: Record<Group, boolean>
  errors: Record<Group, boolean>
  persistenceError: boolean
  navigation: null | Record<string, number | null>
}
const mockDiagnostics = {
  subscribe: () => () => {},
  getSnapshot: () => mockSnapshot,
  getServerSnapshot: () => mockSnapshot,
  updateSettings: (patch: unknown) => mockUpdate(patch),
  clear: () => mockClear(),
  connect: () => mockConnect(),
}
jest.mock("@/lib/perf/renderer-diagnostics", () => ({
  getRendererDiagnostics: () => mockDiagnostics,
}))

import { PerfBrowserDiagnostics } from "./perf-browser-diagnostics"

beforeEach(() => {
  jest.clearAllMocks()
  mockSnapshot = {
    settings: {
      enabled: false,
      resources: true,
      interactions: true,
      navigation: true,
      frames: true,
    },
    supported: { resources: true, interactions: true, navigation: true, frames: true },
    errors: { resources: false, interactions: false, navigation: false, frames: false },
    persistenceError: false,
    navigation: null,
  }
})

it("starts off, disables group controls, and connects only for its lifetime", () => {
  const { unmount } = render(<PerfBrowserDiagnostics />)
  expect(screen.getByRole("switch", { name: "Collect browser diagnostics" })).not.toBeChecked()
  for (const name of ["Resources", "Interactions", "Navigation", "Frame gaps"]) {
    expect(screen.getByRole("switch", { name })).toBeDisabled()
  }
  fireEvent.click(screen.getByRole("switch", { name: "Collect browser diagnostics" }))
  expect(mockUpdate).toHaveBeenCalledWith({ enabled: true })
  expect(mockConnect).toHaveBeenCalledTimes(1)
  unmount()
  expect(mockDisconnect).toHaveBeenCalledTimes(1)
})

it("updates each group independently without replacing the other preferences", () => {
  mockSnapshot.settings.enabled = true
  render(<PerfBrowserDiagnostics />)
  for (const [name, key] of [
    ["Resources", "resources"],
    ["Interactions", "interactions"],
    ["Navigation", "navigation"],
    ["Frame gaps", "frames"],
  ]) {
    fireEvent.click(screen.getByRole("switch", { name }))
    expect(mockUpdate).toHaveBeenLastCalledWith({ [key]: false })
  }
})

it("shows zero as a measurement and missing phases as not yet measured", () => {
  mockSnapshot.settings.enabled = true
  mockSnapshot.navigation = {
    dnsMs: 0,
    connectMs: 1.25,
    tlsMs: null,
    requestMs: 10,
    responseMs: 2,
    domInteractiveMs: 54,
    domContentLoadedMs: 61,
    loadMs: null,
  }
  render(<PerfBrowserDiagnostics />)
  const navigation = screen.getByRole("region", { name: "Document navigation" })
  expect(within(navigation).getByText("0 ms")).toBeInTheDocument()
  expect(within(navigation).getByText("1.3 ms")).toBeInTheDocument()
  expect(within(navigation).getAllByText("Not yet measured or unavailable")).toHaveLength(2)
  fireEvent.click(screen.getByRole("button", { name: "Clear navigation summary" }))
  expect(mockClear).toHaveBeenCalledTimes(1)
})

it("hides stale navigation values as soon as collection or that group is off", () => {
  mockSnapshot.navigation = { dnsMs: 999 }
  const { rerender } = render(<PerfBrowserDiagnostics />)
  expect(screen.queryByText("999 ms")).not.toBeInTheDocument()
  mockSnapshot = {
    ...mockSnapshot,
    settings: { ...mockSnapshot.settings, enabled: true, navigation: false },
  }
  rerender(<PerfBrowserDiagnostics />)
  expect(screen.queryByText("999 ms")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Clear navigation summary" })).toBeDisabled()
})

it("distinguishes unsupported collection, errors, and unsaved preferences", () => {
  mockSnapshot.settings.enabled = true
  mockSnapshot.supported.resources = false
  mockSnapshot.errors.navigation = true
  mockSnapshot.navigation = { dnsMs: 999 }
  mockSnapshot.persistenceError = true
  render(<PerfBrowserDiagnostics />)
  expect(
    within(screen.getByRole("group", { name: "Resources" })).getByText(
      "Unsupported in this runtime"
    )
  ).toBeInTheDocument()
  expect(
    within(screen.getByRole("group", { name: "Navigation" })).getByText("Collection unavailable")
  ).toBeInTheDocument()
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved")
  expect(screen.queryByText("999 ms")).not.toBeInTheDocument()
})

it("explains demand-based local collection and the scope of sampled metrics", () => {
  render(<PerfBrowserDiagnostics />)
  expect(screen.getByText(/performance panel, capture or HUD/)).toBeInTheDocument()
  expect(screen.getByText(/at least 16 ms/)).toBeInTheDocument()
  expect(screen.getByText(/incomplete across origins/)).toBeInTheDocument()
  expect(screen.getByText(/visible frame gaps over 50 ms/)).toBeInTheDocument()
  expect(screen.getByText(/Existing captures remain/)).toBeInTheDocument()
})
