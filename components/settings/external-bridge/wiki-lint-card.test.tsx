/**
 * Coverage for the Wiki Lint card (External Bridge). Drives the run flow, the
 * findings panel, and the schedule editor. Dexie-touching collaborators are
 * mocked so the suite stays hermetic.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WikiLintCard } from "./wiki-lint-card"
import { runWikiLint } from "@/lib/wiki/lint/lint-runner"
import { syncWikiLintCronToScheduler } from "@/lib/wiki/lint/lint-cron-bridge"
import { getWikiLintResult } from "@/lib/db/wiki-lint-results"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { toast } from "sonner"

jest.mock("@/lib/wiki/lint/lint-runner", () => ({ runWikiLint: jest.fn() }))
jest.mock("@/lib/wiki/lint/lint-cron-bridge", () => ({ syncWikiLintCronToScheduler: jest.fn() }))
jest.mock("@/lib/db/wiki-lint-results", () => ({ getWikiLintResult: jest.fn() }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockRun = runWikiLint as jest.Mock
const mockSync = syncWikiLintCronToScheduler as jest.Mock
const mockGetResult = getWikiLintResult as jest.Mock
const mockGetSettings = getSettings as jest.Mock
const mockSaveSettings = saveSettings as jest.Mock

function lintResult(over: Record<string, unknown> = {}) {
  return {
    scope: "cognia-self",
    lastRunAt: 1000,
    articleCount: 4,
    brokenLinks: [],
    orphans: [],
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetResult.mockResolvedValue(undefined)
  mockGetSettings.mockResolvedValue({ externalBridge: { enabled: false, enabledScopes: [] } })
  mockSaveSettings.mockResolvedValue(undefined)
  mockSync.mockResolvedValue({ action: "created" })
})

describe("WikiLintCard", () => {
  it("renders the title and run button", async () => {
    render(<WikiLintCard />)
    expect(await screen.findByText("Wiki Lint")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /run the wiki lint check/i })).toBeInTheDocument()
  })

  it("runs the lint and toasts a clean result", async () => {
    mockRun.mockResolvedValue(lintResult())
    render(<WikiLintCard />)
    await userEvent.click(screen.getByRole("button", { name: /run the wiki lint check/i }))
    await waitFor(() => expect(mockRun).toHaveBeenCalledWith("cognia-self"))
    expect(toast.success).toHaveBeenCalled()
  })

  it("toasts issue counts when problems are found", async () => {
    mockRun.mockResolvedValue(
      lintResult({ brokenLinks: [{ slug: "a", title: "a", deadLinks: ["x"] }] })
    )
    render(<WikiLintCard />)
    await userEvent.click(screen.getByRole("button", { name: /run the wiki lint check/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("surfaces a lint failure via an error toast", async () => {
    mockRun.mockRejectedValue(new Error("boom"))
    render(<WikiLintCard />)
    await userEvent.click(screen.getByRole("button", { name: /run the wiki lint check/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("renders findings from the latest result", async () => {
    mockGetResult.mockResolvedValue(
      lintResult({
        brokenLinks: [{ slug: "bad", title: "Bad", deadLinks: ["ghost"] }],
        orphans: [{ slug: "lonely", title: "Lonely" }],
      })
    )
    render(<WikiLintCard />)
    expect(await screen.findByText(/bad → ghost/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /1 orphan/i }))
    expect(screen.getByText("lonely")).toBeInTheDocument()
  })

  it("saves the schedule and toasts the action", async () => {
    render(<WikiLintCard />)
    await userEvent.click(await screen.findByTestId("wiki-lint-schedule-save"))
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalled())
    expect(mockSync).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalled()
  })
})
