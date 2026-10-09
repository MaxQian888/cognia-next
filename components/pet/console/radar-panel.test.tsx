/**
 * Coverage for the Attention Radar console panel: empty state, report render,
 * the "Run now" flow, and the settings/schedule save. Dexie-touching
 * collaborators are mocked.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RadarPanel } from "./radar-panel"
import { getLatestRadarReport, listRadarReports } from "@/lib/db/radar-reports"
import { runRadarReport, NoRadarModelError } from "@/lib/radar/radar-runner"
import { syncRadarCronToScheduler } from "@/lib/radar/radar-cron-bridge"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { toast } from "sonner"
import type { RadarReport } from "@/types/radar"

jest.mock("@/lib/db/radar-reports", () => ({
  getLatestRadarReport: jest.fn(),
  getRadarReport: jest.fn(),
  listRadarReports: jest.fn(async () => []),
}))
jest.mock("@/lib/radar/radar-runner", () => {
  class NoRadarModelError extends Error {}
  return { runRadarReport: jest.fn(), NoRadarModelError }
})
jest.mock("@/lib/radar/radar-cron-bridge", () => ({
  ...jest.requireActual("@/lib/radar/radar-cron-bridge"),
  syncRadarCronToScheduler: jest.fn(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockLatest = getLatestRadarReport as jest.Mock
const mockRun = runRadarReport as jest.Mock
const mockSync = syncRadarCronToScheduler as jest.Mock
const mockGetSettings = getSettings as jest.Mock
const mockSaveSettings = saveSettings as jest.Mock

function report(): RadarReport {
  return {
    id: "r1",
    scope: "self",
    generatedAt: 1000,
    windowDays: 14,
    itemCount: 8,
    heatmap: [{ day: "2026-07-01", count: 2 }],
    verdict: "you are deep in rust ownership",
    atAGlance: ["highlight one"],
    infoDiet: "mostly technical",
    subconscious: "you like systems",
    graveyard: [{ index: 0, reason: "revisit this" }],
    blindSpots: "no ui reading",
    actions: ["read a design book"],
    topicCloud: [{ topic: "rust", weight: 0.8 }],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLatest.mockResolvedValue(undefined)
  mockGetSettings.mockResolvedValue({})
  mockSaveSettings.mockResolvedValue(undefined)
  mockSync.mockResolvedValue({ action: "created" })
})

describe("RadarPanel", () => {
  it("holds the report's shape while it loads, rather than flashing the empty state", async () => {
    // `undefined` is "still reading"; only a settled `null` means no report.
    mockLatest.mockReturnValue(new Promise(() => {}))
    render(<RadarPanel />)
    const loading = await screen.findByTestId("radar-report-loading")
    expect(loading).toHaveAttribute("data-skeleton", "report")
    expect(loading).toHaveAttribute("aria-busy", "true")
    expect(loading.querySelectorAll("[data-skeleton-item]")).toHaveLength(3)
    expect(screen.queryByText(/No report yet/i)).not.toBeInTheDocument()
  })

  it("shows the empty state when there is no report", async () => {
    render(<RadarPanel />)
    expect(await screen.findByText(/No report yet/i)).toBeInTheDocument()
  })

  it("renders the report sections", async () => {
    mockLatest.mockResolvedValue(report())
    render(<RadarPanel />)
    expect(await screen.findByText("you are deep in rust ownership")).toBeInTheDocument()
    expect(screen.getByText("highlight one")).toBeInTheDocument()
    expect(screen.getByText("read a design book")).toBeInTheDocument()
    expect(screen.getByText("rust")).toBeInTheDocument()
  })

  it("runs the radar and toasts", async () => {
    mockRun.mockResolvedValue(report())
    render(<RadarPanel />)
    await userEvent.click(screen.getByRole("button", { name: /generate a new radar report/i }))
    await waitFor(() => expect(mockRun).toHaveBeenCalledWith({ force: true }))
    expect(toast.success).toHaveBeenCalled()
  })

  it("surfaces the no-model error", async () => {
    mockRun.mockRejectedValue(new NoRadarModelError())
    render(<RadarPanel />)
    await userEvent.click(screen.getByRole("button", { name: /generate a new radar report/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("saves settings + syncs the schedule", async () => {
    render(<RadarPanel />)
    await userEvent.click(await screen.findByTestId("radar-settings-save"))
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalled())
    expect(mockSync).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalled()
  })

  it("does not save an enabled invalid schedule over the previous settings", async () => {
    mockGetSettings.mockResolvedValue({
      attentionRadar: {
        enabled: true,
        windowDays: 14,
        intervalDays: 3,
        schedule: { mode: "custom", customCron: "invalid" },
      },
    })
    render(<RadarPanel />)
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked())
    await userEvent.click(screen.getByTestId("radar-settings-save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(mockSaveSettings).not.toHaveBeenCalled()
    expect(mockSync).not.toHaveBeenCalled()
  })

  it("picks a past report from the shared Select, dated in the app locale", async () => {
    const past = { ...report(), id: "r0", generatedAt: Date.UTC(2026, 6, 1, 9, 30) }
    ;(listRadarReports as jest.Mock).mockResolvedValue([past])
    render(<RadarPanel />)
    const user = userEvent.setup()
    const trigger = await screen.findByRole("combobox", { name: /history|decisions\.history/i })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    await user.click(trigger)
    const expected = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(past.generatedAt)
    expect(await screen.findByRole("option", { name: new RegExp(expected) })).toBeInTheDocument()
  })
})
