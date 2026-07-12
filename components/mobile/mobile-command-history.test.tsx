/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { TerminalHistoryRow } from "@/lib/db/terminal-history"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
  useFormatter: () => ({ relativeTime: () => "just now" }),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}))

const writeClipboardText = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (text: string) => writeClipboardText(text),
}))

// Drive the Dexie-first hook from a module-level fixture the tests reassign,
// so the component never touches IndexedDB or the sync transport.
let fixtureRows: TerminalHistoryRow[] = []
jest.mock("@/hooks/data/use-dexie-first-query", () => ({
  useDexieFirstQuery: () => ({
    data: fixtureRows,
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  }),
}))

const execTerminalCommand = jest.fn()
jest.mock("@/lib/terminal/remote-api", () => ({
  execTerminalCommand: (req: unknown) => execTerminalCommand(req),
}))

import { MobileCommandHistory } from "./mobile-command-history"

function row(over: Partial<TerminalHistoryRow> & { id: string }): TerminalHistoryRow {
  return {
    command: "ls",
    projectId: "",
    shell: "pwsh.exe",
    cwd: null,
    exitCode: 0,
    ts: 1000,
    uses: 1,
    sessionId: "s1",
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  fixtureRows = []
})

describe("MobileCommandHistory", () => {
  it("shows the empty state when nothing has synced", () => {
    render(<MobileCommandHistory />)
    expect(screen.getByTestId("command-history-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("command-history-no-results")).toBeNull()
  })

  it("groups rows by project and labels the projectless bucket", () => {
    fixtureRows = [
      row({ id: "a", command: "git status", projectId: "repo-x", ts: 30, uses: 2 }),
      row({ id: "b", command: "ls -la", projectId: "", ts: 20 }),
    ]
    render(<MobileCommandHistory />)
    expect(screen.getByTestId("command-history-row-a")).toHaveTextContent("git status")
    expect(screen.getByTestId("command-history-row-b")).toHaveTextContent("ls -la")
    // Named project heads its own section; the projectless bucket uses noProject.
    expect(screen.getByText("repo-x")).toBeInTheDocument()
    expect(screen.getByText("mobile.commandHistory.noProject")).toBeInTheDocument()
  })

  it("orders named project groups alphabetically and sinks the projectless bucket last", () => {
    fixtureRows = [
      row({ id: "z", command: "z cmd", projectId: "zephyr", ts: 40 }),
      row({ id: "n", command: "n cmd", projectId: "", ts: 30 }),
      row({ id: "a", command: "a cmd", projectId: "alpha", ts: 20 }),
    ]
    render(<MobileCommandHistory />)
    const headings = screen.getAllByRole("heading").map((h) => h.textContent)
    // alpha < zephyr, and the projectless (noProject) bucket is always last.
    expect(headings).toEqual(["alpha", "zephyr", "mobile.commandHistory.noProject"])
  })

  it("renders the run count and relative time per row", () => {
    fixtureRows = [row({ id: "a", command: "pnpm test", uses: 3 })]
    render(<MobileCommandHistory />)
    const row_ = screen.getByTestId("command-history-row-a")
    // uses is pluralized via next-intl; the mock echoes the params.
    expect(row_).toHaveTextContent('mobile.commandHistory.uses:{"count":3}')
    expect(row_).toHaveTextContent("just now")
  })

  it("filters by substring over the command", async () => {
    fixtureRows = [
      row({ id: "a", command: "git status", ts: 30 }),
      row({ id: "b", command: "pnpm test", ts: 20 }),
    ]
    render(<MobileCommandHistory />)
    await userEvent.type(screen.getByTestId("command-history-search"), "pnpm")
    expect(screen.queryByTestId("command-history-row-a")).toBeNull()
    expect(screen.getByTestId("command-history-row-b")).toBeInTheDocument()
  })

  it("shows a no-results state when the search matches nothing", async () => {
    fixtureRows = [row({ id: "a", command: "git status" })]
    render(<MobileCommandHistory />)
    await userEvent.type(screen.getByTestId("command-history-search"), "zzz")
    expect(screen.getByTestId("command-history-no-results")).toBeInTheDocument()
    expect(screen.queryByTestId("command-history-row-a")).toBeNull()
  })

  it("copies the command to the clipboard on tap (read-only, no rerun)", async () => {
    fixtureRows = [row({ id: "a", command: "git status" })]
    render(<MobileCommandHistory />)
    await userEvent.click(screen.getByTestId("command-history-row-a"))
    expect(writeClipboardText).toHaveBeenCalledWith("git status")
    expect(toastSuccess).toHaveBeenCalledWith("mobile.commandHistory.copied")
  })

  it("surfaces a toast when the clipboard write fails", async () => {
    writeClipboardText.mockRejectedValueOnce(new Error("no clipboard"))
    fixtureRows = [row({ id: "a", command: "git status" })]
    render(<MobileCommandHistory />)
    await userEvent.click(screen.getByTestId("command-history-row-a"))
    expect(toastError).toHaveBeenCalledWith("mobile.commandHistory.copyError")
  })

  describe("run on desktop", () => {
    it("asks for confirmation and does not exec until confirmed", async () => {
      fixtureRows = [row({ id: "a", command: "git status" })]
      render(<MobileCommandHistory />)
      await userEvent.click(screen.getByTestId("command-history-run-a"))
      expect(screen.getByTestId("command-history-run-dialog")).toBeInTheDocument()
      expect(execTerminalCommand).not.toHaveBeenCalled()
      // Cancel closes without running.
      await userEvent.click(screen.getByTestId("command-history-run-cancel"))
      expect(execTerminalCommand).not.toHaveBeenCalled()
      expect(screen.queryByTestId("command-history-run-dialog")).toBeNull()
    })

    it("execs the command in shell mode on confirm and shows the output", async () => {
      execTerminalCommand.mockResolvedValueOnce({
        stdout: "On branch dev",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      })
      fixtureRows = [row({ id: "a", command: "git status" })]
      render(<MobileCommandHistory />)
      await userEvent.click(screen.getByTestId("command-history-run-a"))
      await userEvent.click(screen.getByTestId("command-history-run-confirm"))
      expect(execTerminalCommand).toHaveBeenCalledWith({
        command: "git status",
        shell: true,
        timeoutMs: 60_000,
      })
      const result = await screen.findByTestId("command-history-run-result")
      expect(result).toHaveTextContent("On branch dev")
      expect(result).toHaveTextContent('mobile.commandHistory.run.exitCode:{"code":0}')
    })

    it("marks a timed-out run and shows stderr when stdout is empty", async () => {
      execTerminalCommand.mockResolvedValueOnce({
        stdout: "",
        stderr: "command timed out after 60000ms",
        exitCode: null,
        timedOut: true,
      })
      fixtureRows = [row({ id: "a", command: "sleep 999" })]
      render(<MobileCommandHistory />)
      await userEvent.click(screen.getByTestId("command-history-run-a"))
      await userEvent.click(screen.getByTestId("command-history-run-confirm"))
      const result = await screen.findByTestId("command-history-run-result")
      expect(result).toHaveTextContent("mobile.commandHistory.run.timedOut")
      expect(result).toHaveTextContent("command timed out after 60000ms")
    })

    it("closes the dialog and toasts when the RPC rejects (e.g. 403)", async () => {
      execTerminalCommand.mockRejectedValueOnce(new Error("remote control not allowed"))
      fixtureRows = [row({ id: "a", command: "git status" })]
      render(<MobileCommandHistory />)
      await userEvent.click(screen.getByTestId("command-history-run-a"))
      await userEvent.click(screen.getByTestId("command-history-run-confirm"))
      expect(toastError).toHaveBeenCalledWith(
        'mobile.commandHistory.runError:{"message":"remote control not allowed"}'
      )
      expect(screen.queryByTestId("command-history-run-dialog")).toBeNull()
    })
  })
})
