/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { BackgroundTasksCard } from "./background-tasks-card"

const save = jest.fn().mockResolvedValue(undefined)
let mockSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings, save }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/logging", () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = {}
})

describe("BackgroundTasksCard", () => {
  it("defaults: auto-resume off (attempts disabled), asks surfaced", () => {
    render(<BackgroundTasksCard />)
    expect(screen.getByRole("switch", { name: "autoResume" })).not.toBeChecked()
    expect(screen.getByLabelText("maxAttempts")).toBeDisabled()
    expect(screen.getByRole("switch", { name: "surfaceAsks" })).toBeChecked()
  })

  it("hydrates from existing settings incl. deny-list globs", () => {
    mockSettings = {
      backgroundTasks: { autoResumeInterrupted: true, maxAutoResumeAttempts: 4 },
      agentPermissions: {
        subagentAsks: "auto-deny",
        subagentRules: { "template:*": "deny", Explore: "allow" },
      },
    }
    render(<BackgroundTasksCard />)
    expect(screen.getByRole("switch", { name: "autoResume" })).toBeChecked()
    expect(screen.getByLabelText("maxAttempts")).toHaveValue(4)
    expect(screen.getByRole("switch", { name: "surfaceAsks" })).not.toBeChecked()
    // Only the deny rule is shown in the editor (allow rules are not deny-list).
    expect(screen.getByLabelText("denyList")).toHaveValue("template:*")
  })

  it("saves auto-resume + surfaceAsks + parsed deny-list", () => {
    render(<BackgroundTasksCard />)
    fireEvent.click(screen.getByRole("switch", { name: "autoResume" }))
    fireEvent.change(screen.getByLabelText("maxAttempts"), { target: { value: "3" } })
    fireEvent.click(screen.getByRole("switch", { name: "surfaceAsks" })) // → auto-deny
    fireEvent.change(screen.getByLabelText("denyList"), {
      target: { value: "template:*\n myplugin:reviewer \n\n" },
    })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith({
      backgroundTasks: { autoResumeInterrupted: true, maxAutoResumeAttempts: 3 },
      agentPermissions: {
        subagentAsks: "auto-deny",
        subagentRules: { "template:*": "deny", "myplugin:reviewer": "deny" },
      },
    })
  })

  it("clears the dispatch rules when the deny-list is emptied", () => {
    mockSettings = { agentPermissions: { subagentRules: { "template:*": "deny" } } }
    render(<BackgroundTasksCard />)
    fireEvent.change(screen.getByLabelText("denyList"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPermissions: expect.objectContaining({ subagentRules: undefined }),
      })
    )
  })

  it("preserves unrelated agentPermissions fields on save", () => {
    mockSettings = { agentPermissions: { commandRules: { "git push*": "ask" } } }
    render(<BackgroundTasksCard />)
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPermissions: expect.objectContaining({ commandRules: { "git push*": "ask" } }),
      })
    )
  })
})
