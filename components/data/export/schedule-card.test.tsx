import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@cognia/agent-config-types"

const saveMock = jest.fn(async (..._args: unknown[]) => {})
const settingsState = {
  settings: {
    backupAutoSchedule: {
      ...DEFAULT_BACKUP_AUTO_SCHEDULE,
      dirPath: "/Users/alice/Google Drive/private-backups",
    },
    backupReminderDays: 7,
  },
  save: saveMock,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

const routerPushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}))
const startNewSessionMock = jest.fn(async (..._args: unknown[]) => ({ id: "cloud-session" }))
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSessionMock(...args),
}))
const queuePendingChatPromptMock = jest.fn()
jest.mock("@/lib/chat/pending-prompt", () => ({
  queuePendingChatPrompt: (...args: unknown[]) => queuePendingChatPromptMock(...args),
}))

import { ScheduleCard } from "./schedule-card"

describe("ScheduleCard", () => {
  beforeEach(() => {
    saveMock.mockClear()
    routerPushMock.mockClear()
    startNewSessionMock.mockClear()
    startNewSessionMock.mockResolvedValue({ id: "cloud-session" })
    queuePendingChatPromptMock.mockClear()
  })

  it("documents desktop-synced cloud folders and opens credential-free AI setup", async () => {
    const user = userEvent.setup()
    render(<ScheduleCard />)

    expect(screen.getByText("Google Drive")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Official setup guide/ })).toHaveAttribute(
      "href",
      expect.stringContaining("support.google.com")
    )

    await user.click(screen.getByRole("button", { name: "Configure cloud folder with AI" }))

    await waitFor(() => expect(startNewSessionMock).toHaveBeenCalled())
    expect(queuePendingChatPromptMock).toHaveBeenCalledWith(
      "cloud-session",
      expect.stringContaining("Google Drive")
    )
    const prompt = queuePendingChatPromptMock.mock.calls[0]?.[1] as string
    expect(prompt).not.toContain("/Users/alice")
    expect(routerPushMock).toHaveBeenCalledWith("/")
  })
})
