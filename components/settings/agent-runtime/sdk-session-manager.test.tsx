import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const listSdkSessions = jest.fn()
const renameSdkSession = jest.fn()
const deleteSdkSession = jest.fn()
const forkSdkSession = jest.fn()
const importSdkSessionToStore = jest.fn()
const toastError = jest.fn()

jest.mock("@/lib/claude/ipc", () => ({
  listSdkSessions: (...args: unknown[]) => listSdkSessions(...args),
  renameSdkSession: (...args: unknown[]) => renameSdkSession(...args),
  deleteSdkSession: (...args: unknown[]) => deleteSdkSession(...args),
  forkSdkSession: (...args: unknown[]) => forkSdkSession(...args),
  importSdkSessionToStore: (...args: unknown[]) => importSdkSessionToStore(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  getAgentExecutionFlags: () => ({
    claudeSdkParityV1: true,
    claudeSdkSessionStore: true,
  }),
  isAgentExecutionFlagEnabled: () => true,
  subscribeToAgentExecutionFlags: () => () => {},
}))
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: jest.fn() },
}))

import { SdkSessionManager } from "./sdk-session-manager"

beforeEach(() => {
  jest.clearAllMocks()
  listSdkSessions.mockResolvedValue([
    { sessionId: "sdk-1", summary: "Fix auth", lastModified: 10, cwd: "/repo", tag: "work" },
  ])
  renameSdkSession.mockResolvedValue(undefined)
  deleteSdkSession.mockResolvedValue(undefined)
  forkSdkSession.mockResolvedValue({ sessionId: "sdk-2" })
  importSdkSessionToStore.mockResolvedValue({ imported: true })
})

describe("SdkSessionManager", () => {
  it("lists native SDK sessions and supports rename, fork, and confirmed delete", async () => {
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    expect(screen.getByText("/repo")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Rename SDK session" }))
    const input = screen.getByRole("textbox", { name: "Session title" })
    await user.clear(input)
    await user.type(input, "Fixed auth")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(renameSdkSession).toHaveBeenCalledWith("sdk-1", "Fixed auth"))

    await user.click(screen.getByRole("button", { name: "Fork SDK session" }))
    await waitFor(() => expect(forkSdkSession).toHaveBeenCalledWith("sdk-1"))

    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() => expect(deleteSdkSession).toHaveBeenCalledWith("sdk-1"))
  })

  it("surfaces load failures and retries", async () => {
    listSdkSessions.mockRejectedValueOnce(new Error("SDK unavailable"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("SDK sessions could not be loaded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Refresh SDK sessions" }))
    await waitFor(() => expect(listSdkSessions).toHaveBeenCalledTimes(2))
  })

  it("localizes rename failures", async () => {
    renameSdkSession.mockRejectedValueOnce(new Error("raw rename failure"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Rename SDK session" }))
    const input = screen.getByRole("textbox", { name: "Session title" })
    await user.clear(input)
    await user.type(input, "Renamed")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be renamed.")
    )
  })

  it("localizes fork failures", async () => {
    forkSdkSession.mockRejectedValueOnce(new Error("raw fork failure"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Fork SDK session" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be forked.")
    )
  })

  it("localizes delete failures", async () => {
    deleteSdkSession.mockRejectedValueOnce(new Error("raw delete failure"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be deleted.")
    )
  })

  it("imports a native transcript through the configured host SessionStore", async () => {
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Import into SessionStore" }))

    await waitFor(() =>
      expect(importSdkSessionToStore).toHaveBeenCalledWith(
        "sdk-1",
        expect.objectContaining({
          cwd: "/repo",
          execution: expect.objectContaining({
            hostRef: "desktop-sidecar",
            runtimeAdapter: "claude-agent-sdk",
          }),
          claudeAgentSdk: {
            version: 1,
            persistSession: true,
            sessionStore: { backend: "host-sqlite" },
          },
        })
      )
    )
  })

  it("localizes SessionStore import failures", async () => {
    importSdkSessionToStore.mockRejectedValueOnce(new Error("raw import failure"))
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Import into SessionStore" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be imported.")
    )
  })
})
