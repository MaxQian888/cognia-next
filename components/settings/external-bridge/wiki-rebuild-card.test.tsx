/**
 * Coverage for the Wiki Index card (External Bridge). The card was previously
 * untested; these specs drive the rebuild-confirm flow, the schedule editor,
 * the locale-routed status grid, and every error branch of the orchestrator
 * and cron-sync calls. Dexie-touching collaborators are mocked so the suite
 * stays hermetic and fast.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WikiRebuildCard } from "./wiki-rebuild-card"
import { isTauri } from "@/lib/tauri"
import { runWikiRebuild, WebModeError, NoApiKeyError } from "@/lib/wiki/rebuild-runner"
import { syncWikiCronToScheduler } from "@/lib/wiki/schedule/cron-bridge"
import { getWikiManifest } from "@/lib/db/wiki-manifest"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { toast } from "sonner"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

jest.mock("@/lib/wiki/rebuild-runner", () => {
  // Local error classes so `instanceof` checks in the component resolve against
  // the same constructors we throw from tests — without importing the real
  // orchestrator (which drags in server-only deps).
  class WebModeError extends Error {}
  class NoApiKeyError extends Error {}
  return { WebModeError, NoApiKeyError, runWikiRebuild: jest.fn() }
})

jest.mock("@/lib/wiki/schedule/cron-bridge", () => ({ syncWikiCronToScheduler: jest.fn() }))
jest.mock("@/lib/db/wiki-manifest", () => ({ getWikiManifest: jest.fn() }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockIsTauri = isTauri as jest.Mock
const mockRun = runWikiRebuild as jest.Mock
const mockSyncCron = syncWikiCronToScheduler as jest.Mock
const mockManifest = getWikiManifest as jest.Mock
const mockGetSettings = getSettings as jest.Mock
const mockSaveSettings = saveSettings as jest.Mock

function rebuildResult(over: Partial<Record<string, unknown>> = {}) {
  return { added: 0, changed: 0, removed: 0, unchanged: 0, errors: [], durationMs: 500, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(true)
  mockManifest.mockResolvedValue(undefined)
  mockGetSettings.mockResolvedValue({ externalBridge: { enabled: false, enabledScopes: [] } })
  mockSaveSettings.mockResolvedValue(undefined)
  mockSyncCron.mockResolvedValue({ action: "created" })
})

describe("WikiRebuildCard — status grid", () => {
  it("renders the i18n-routed scope value and empty status", async () => {
    render(<WikiRebuildCard />)
    expect(await screen.findByText("cognia-self")).toBeInTheDocument()
    expect(screen.getByText("Wiki Index")).toBeInTheDocument()
    // No manifest → article count 0, generator em-dash, last build "Never".
    expect(screen.getByText("Never")).toBeInTheDocument()
    expect(screen.getByText("0")).toBeInTheDocument()
  })

  it("renders manifest metadata when a build exists", async () => {
    mockManifest.mockResolvedValue({
      scope: "cognia-self",
      lastBuildAt: 1_700_000_000_000,
      articleCount: 42,
      generatorVersion: "v9",
    })
    render(<WikiRebuildCard />)
    expect(await screen.findByText("42")).toBeInTheDocument()
    expect(screen.getByText("v9")).toBeInTheDocument()
  })

  it("shows the web-mode description and disables actions off-desktop", async () => {
    mockIsTauri.mockReturnValue(false)
    render(<WikiRebuildCard />)
    expect(
      await screen.findByText(/Wiki rebuild requires the Tauri desktop app/i)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Rebuild the Cognia wiki/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Save wiki rebuild schedule/i })).toBeDisabled()
  })
})

describe("WikiRebuildCard — rebuild flow", () => {
  it("confirms before rebuilding and reports an incremental success summary", async () => {
    const user = userEvent.setup()
    mockRun.mockResolvedValue(rebuildResult({ added: 2, changed: 1, removed: 1, durationMs: 4500 }))
    render(<WikiRebuildCard />)

    await user.click(await screen.findByRole("button", { name: /Rebuild the Cognia wiki/i }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Rebuild Wiki?")).toBeInTheDocument()
    // Force is off → incremental confirmation copy.
    expect(
      within(dialog).getByText(/index changed files since the last build/i)
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: /^Rebuild$/i }))

    await waitFor(() => expect(mockRun).toHaveBeenCalledWith({ force: false }))
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("2 added"))
    // Result grid renders the per-bucket counts.
    expect(await screen.findByText("added")).toBeInTheDocument()
  })

  it("uses the force confirmation copy and passes force:true when toggled", async () => {
    const user = userEvent.setup()
    mockRun.mockResolvedValue(rebuildResult())
    render(<WikiRebuildCard />)

    await user.click(await screen.findByRole("switch", { name: /Toggle full rebuild/i }))
    await user.click(screen.getByRole("button", { name: /Rebuild the Cognia wiki/i }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText(/re-index the entire codebase from scratch/i)
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: /^Rebuild$/i }))

    await waitFor(() => expect(mockRun).toHaveBeenCalledWith({ force: true }))
    // No buckets changed → "no changes" summary branch.
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("no changes"))
  })

  it("maps WebModeError to the desktop-only warning toast", async () => {
    const user = userEvent.setup()
    mockRun.mockRejectedValue(new WebModeError())
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Rebuild the Cognia wiki/i }))
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /^Rebuild$/i })
    )
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Wiki rebuild requires the Tauri desktop app")
      )
    )
  })

  it("maps NoApiKeyError to the providers hint toast", async () => {
    const user = userEvent.setup()
    mockRun.mockRejectedValue(new NoApiKeyError())
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Rebuild the Cognia wiki/i }))
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /^Rebuild$/i })
    )
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("No LLM API key configured"))
    )
  })

  it("maps an unknown rebuild error to the generic failure toast", async () => {
    const user = userEvent.setup()
    mockRun.mockRejectedValue(new Error("boom"))
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Rebuild the Cognia wiki/i }))
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /^Rebuild$/i })
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("boom")))
  })

  it("renders the error summary and collapsible error list when buckets report errors", async () => {
    const user = userEvent.setup()
    mockRun.mockResolvedValue(
      rebuildResult({ added: 1, errors: [{ module: "a.ts", message: "parse failed" }] })
    )
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Rebuild the Cognia wiki/i }))
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /^Rebuild$/i })
    )

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("1 failed"))
    )
    await user.click(screen.getByRole("button", { name: /1 error/i }))
    // The shadcn Collapsible trigger reveals the per-error row.
    expect(await screen.findByText(/a\.ts: parse failed/i)).toBeInTheDocument()
  })

  it("cancelling the confirmation dialog does not rebuild", async () => {
    const user = userEvent.setup()
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Rebuild the Cognia wiki/i }))
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /Cancel/i })
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(mockRun).not.toHaveBeenCalled()
  })
})

describe("WikiRebuildCard — schedule editor", () => {
  it("reveals an editable cron input when the mode switches to custom", async () => {
    const user = userEvent.setup()
    render(<WikiRebuildCard />)
    await screen.findByText("cognia-self")
    await user.click(screen.getByRole("combobox", { name: /Frequency/i }))
    await user.click(await screen.findByRole("option", { name: /Custom/i }))
    const cron = await screen.findByTestId("wiki-schedule-custom-cron")
    await user.type(cron, "5 4 * * 0")
    expect(cron).toHaveValue("5 4 * * 0")
  })

  it("toggles the force-on-fire flag for a recurring (non-custom) schedule", async () => {
    const user = userEvent.setup()
    render(<WikiRebuildCard />)
    await screen.findByText("cognia-self")
    await user.click(screen.getByRole("combobox", { name: /Frequency/i }))
    await user.click(await screen.findByRole("option", { name: /Daily/i }))
    const force = await screen.findByTestId("wiki-schedule-force")
    expect(force).not.toBeChecked()
    await user.click(force)
    expect(force).toBeChecked()
  })

  it("hydrates a persisted schedule from settings", async () => {
    mockGetSettings.mockResolvedValue({
      externalBridge: {
        enabled: false,
        enabledScopes: [],
        wikiSchedule: { mode: "custom", customCron: "0 5 * * *" },
      },
    })
    render(<WikiRebuildCard />)
    expect(await screen.findByTestId("wiki-schedule-custom-cron")).toHaveValue("0 5 * * *")
  })

  it.each([
    ["created", "success", /Wiki rebuild schedule created/i],
    ["updated", "success", /Wiki rebuild schedule updated/i],
    ["deleted", "success", /Wiki rebuild schedule cleared/i],
  ] as const)(
    "saving a schedule that resolves %s toasts the matching message",
    async (action, kind, pattern) => {
      const user = userEvent.setup()
      mockSyncCron.mockResolvedValue({ action })
      render(<WikiRebuildCard />)
      await user.click(await screen.findByRole("button", { name: /Save wiki rebuild schedule/i }))
      await waitFor(() => expect(mockSaveSettings).toHaveBeenCalled())
      expect(mockSyncCron).toHaveBeenCalled()
      expect(toast[kind]).toHaveBeenCalledWith(expect.stringMatching(pattern))
    }
  )

  it("falls back to a fresh bridge config when none is persisted yet", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue({}) // no externalBridge → defensive default branch
    mockSyncCron.mockResolvedValue({ action: "created" })
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Save wiki rebuild schedule/i }))
    await waitFor(() =>
      expect(mockSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          externalBridge: expect.objectContaining({ enabled: false, enabledScopes: [] }),
        })
      )
    )
  })

  it("surfaces an invalid cron expression as an error toast", async () => {
    const user = userEvent.setup()
    mockSyncCron.mockResolvedValue({ action: "invalid", invalidExpression: "nope" })
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Save wiki rebuild schedule/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("nope")))
  })

  it("reports a thrown cron-sync failure as an error toast", async () => {
    const user = userEvent.setup()
    mockSyncCron.mockRejectedValue(new Error("scheduler down"))
    render(<WikiRebuildCard />)
    await user.click(await screen.findByRole("button", { name: /Save wiki rebuild schedule/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("scheduler down"))
    )
  })
})
