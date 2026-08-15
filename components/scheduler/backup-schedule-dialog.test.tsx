import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { BackupScheduleDialog } from "./backup-schedule-dialog"

const createTask = jest.fn()
const onScheduled = jest.fn()

const readinessMock = jest.fn(async () => [
  { destination: "local", state: "ready" },
  { destination: "github", state: "not-configured", reason: "github" },
  { destination: "googledrive", state: "ready" },
  { destination: "convex", state: "deprecated" },
])
jest.mock("@/lib/data/destinations/config", () => ({
  describeBackupDestinationReadiness: () => readinessMock(),
}))
jest.mock("@/hooks/scheduler", () => ({
  useScheduler: () => ({
    createTask,
    isInitialized: true,
  }),
}))

const messages = {
  scheduler: {
    taskName: "Task name",
    selectPreset: "Pick a preset",
    timezone: "Timezone",
    advancedSettings: "Advanced settings",
    maxRetries: "Max retries",
    retryDelayMs: "Retry delay (ms)",
    maxMissedRuns: "Max missed runs",
    runMissedOnStartup: "Run missed on startup",
    allowConcurrent: "Allow concurrent",
    schedule: "Schedule",
    scheduling: "Scheduling…",
    notificationSettings: {
      title: "Notifications",
      onComplete: "On complete",
      onError: "On error",
    },
    backup: {
      schedule: "Schedule backup",
      scheduleTitle: "Schedule backup",
      scheduleDescription: "Run encrypted backups on a cron schedule.",
      namePlaceholder: "Daily backup",
      scheduleFrequency: "Frequency",
      preset: {
        daily: "Every day at 2 AM",
        weekly: "Every Sunday at 2 AM",
        monthly: "Every month at 2 AM",
        every6h: "Every 6 hours",
      },
      type: "Backup type",
      types: { full: "Full", sessions: "Sessions only", settings: "Settings only", all: "All" },
      destination: "Destination",
      destinations: {
        local: "Local file",
        webdav: "WebDAV Server",
        github: "GitHub Repository",
        googledrive: "Google Drive",
        all: "All targets",
      },
      destinationLocalHint: "Saved to appDataDir()/backups.",
      destinationWebdavHint: "Uploaded to the configured WebDAV server.",
      destinationGithubHint: "Committed to GitHub.",
      destinationGoogleDriveHint: "Uploaded to Drive.",
      destinationAllHint: "Everything.",
      destinationNotConfigured: "not configured",
      includeOptions: "Include in backup",
      options: {
        sessions: "Sessions",
        settings: "Settings",
        artifacts: "Artifacts",
        indexedDB: "IndexedDB",
      },
    },
  },
  common: { cancel: "Cancel" },
}

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BackupScheduleDialog onScheduled={onScheduled} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  createTask.mockReset()
  onScheduled.mockReset()
})

describe("BackupScheduleDialog", () => {
  it("opens via the default trigger and defaults the destination to local", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /schedule backup/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    // The destination select shows the default (local) selection.
    expect(screen.getByText(/local file/i)).toBeInTheDocument()
    // Deprecated convex is gone; github/googledrive are offered but disabled
    // until configured (Working Rule 7 — inert, never hidden).
    expect(screen.queryByText(/convex/i)).not.toBeInTheDocument()
  })

  it("disables submit when the task name is blank", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /schedule backup/i }))
    const dialog = screen.getByRole("dialog")
    const nameInput = within(dialog).getByLabelText(/task name/i)
    fireEvent.change(nameInput, { target: { value: "" } })
    const submit = within(dialog).getByRole("button", { name: /^schedule$/i })
    expect(submit).toBeDisabled()
  })

  it("submits a backup task with destination=local", async () => {
    createTask.mockResolvedValueOnce({ id: "task-42" })
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /schedule backup/i }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: /^schedule$/i }))

    await screen.findByRole("dialog", undefined, { timeout: 1000 }).catch(() => null)

    expect(createTask).toHaveBeenCalledTimes(1)
    const arg = createTask.mock.calls[0][0]
    expect(arg.type).toBe("backup")
    expect(arg.payload.destination).toBe("local")
    expect(arg.payload.backupType).toBe("full")
    expect(arg.trigger.cronExpression).toBe("0 2 * * *")
    expect(onScheduled).toHaveBeenCalledWith("task-42")
  })

  it("toggles the advanced section", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /schedule backup/i }))
    const dialog = screen.getByRole("dialog")
    // Advanced section is collapsed: max-retries label not visible by default.
    expect(within(dialog).queryByText(/^max retries$/i)).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: /advanced settings/i }))
    expect(within(dialog).getByText(/^max retries$/i)).toBeInTheDocument()
  })
})
