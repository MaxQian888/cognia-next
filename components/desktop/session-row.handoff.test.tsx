/**
 * @jest-environment jsdom
 *
 * Covers the "Open in terminal" affordance added to SessionRow (desktop→CLI
 * handoff). Kept separate from session-row.test.tsx so the isTauri=true mock
 * doesn't affect the base suite (which exercises the non-Tauri layout).
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, params?: Record<string, unknown>) =>
    params ? `${k}:${JSON.stringify(params)}` : k,
  // The row formats its own activity timestamp; these tests only care about
  // the handoff menu, so a stub formatter is enough.
  useFormatter: () => ({ dateTime: (value: Date) => String(value.getTime()) }),
  useNow: () => new Date(1_750_000_000_000),
}))
jest.mock("@cognia/logging", () => ({ loggers: { ui: { info: jest.fn(), warn: jest.fn() } } }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@tauri-apps/api/path", () => ({ homeDir: jest.fn(async () => "/home/u") }))
jest.mock("@/lib/cli-bridge/detect-cli", () => ({ detectCli: jest.fn() }))
jest.mock("@/lib/terminal/run-cognia", () => ({ launchCogniaAgent: jest.fn() }))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: jest.fn(() => ({ setPanelOpen: jest.fn() })) },
}))

const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: unknown) => mockToastSuccess(m), error: (m: unknown) => mockToastError(m) },
}))

const mockListMessages = jest.fn(async (_id?: unknown) => [{ id: "m", role: "user", parts: [] }])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: unknown) => mockListMessages(id),
}))

const mockExport = jest.fn(async (_params?: unknown) => ({
  path: "/home/u/.cognia/handoff/s-1.jsonl",
  command: "cognia-agent resume s-1",
}))
jest.mock("@/lib/chat/export-handoff-to-cli", () => ({
  exportHandoffToCli: (params: unknown) => mockExport(params),
}))

const mockDispatchSessionToCodexApp = jest.fn()
jest.mock("@/lib/chat/dispatch-to-codex-app", () => ({
  dispatchSessionToCodexApp: (session: unknown) => mockDispatchSessionToCodexApp(session),
}))

import { SessionRow } from "./session-row"
import { detectCli } from "@/lib/cli-bridge/detect-cli"
import { launchCogniaAgent } from "@/lib/terminal/run-cognia"

const mockDetectCli = detectCli as jest.MockedFunction<typeof detectCli>
const mockLaunchCogniaAgent = launchCogniaAgent as jest.MockedFunction<typeof launchCogniaAgent>

const baseSession: ChatSession = {
  id: "s-1",
  title: "Hello",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

function setup() {
  return render(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        onSelect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDetectCli.mockResolvedValue({
    available: true,
    version: "0.1.0",
    path: "/usr/local/bin/cognia-agent",
    error: null,
  })
  mockLaunchCogniaAgent.mockResolvedValue({ kind: "launched", sessionId: "terminal-1" })
  mockDispatchSessionToCodexApp.mockResolvedValue({ threadId: "thread-1" })
})

test("Open in terminal presence-checks, exports, and launches the resume command", async () => {
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInTerminal")
  await waitFor(() =>
    expect(item.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled")
  )
  await user.click(item)

  expect(mockDetectCli).toHaveBeenCalledWith("cognia-agent")
  expect(mockListMessages).toHaveBeenCalledWith("s-1")
  expect(mockExport).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }))
  expect(mockLaunchCogniaAgent).toHaveBeenCalledWith(
    expect.objectContaining({ handoffSessionId: "s-1", cwd: "/home/u" })
  )
  expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("openedInTerminal"))
})

test("Open in terminal stays disabled when cognia-agent is absent", async () => {
  mockDetectCli.mockResolvedValueOnce({
    available: false,
    version: null,
    path: null,
    error: "not found",
  })
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInTerminal")
  await waitFor(() => expect(item.closest('[role="menuitem"]')).toHaveAttribute("data-disabled"))
  expect(item.closest('[role="menuitem"]')).toHaveAttribute("title", "cogniaAgentNotInstalled")
  expect(mockExport).not.toHaveBeenCalled()
})

test("a failed export surfaces an error toast", async () => {
  mockExport.mockRejectedValueOnce(new Error("no home"))
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInTerminal")
  await waitFor(() =>
    expect(item.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled")
  )
  await user.click(item)
  expect(mockToastError).toHaveBeenCalledWith("openInTerminalFailed")
})

test("Open in Codex App dispatches independently of cognia-agent availability", async () => {
  mockDetectCli.mockResolvedValueOnce({
    available: false,
    version: null,
    path: null,
    error: "not found",
  })
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInCodexApp")
  expect(item.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled")

  await user.click(item)

  expect(mockDispatchSessionToCodexApp).toHaveBeenCalledWith(baseSession)
  expect(mockToastSuccess).toHaveBeenCalledWith("openedInCodexApp")
})

test("a failed Codex App dispatch surfaces an error toast", async () => {
  mockDispatchSessionToCodexApp.mockRejectedValueOnce(new Error("app too old"))
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("openInCodexApp"))
  await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("openInCodexAppFailed"))
})

test("a denied terminal launch surfaces the failure instead of a success toast", async () => {
  // `launchCogniaAgent` resolving is not the same as it launching — a denied
  // or errored outcome must not report success.
  mockLaunchCogniaAgent.mockResolvedValueOnce({ kind: "denied", reason: "policy" })
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInTerminal")
  await waitFor(() =>
    expect(item.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled")
  )
  await user.click(item)

  await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("openInTerminalFailed"))
  expect(mockToastSuccess).not.toHaveBeenCalled()
})

test("an errored terminal launch reports the backend message path", async () => {
  mockLaunchCogniaAgent.mockResolvedValueOnce({ kind: "error", message: "spawn failed" })
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInTerminal")
  await waitFor(() =>
    expect(item.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled")
  )
  await user.click(item)

  await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("openInTerminalFailed"))
})

test("hands the session's own working directory to the terminal launch", async () => {
  // Only when the session has no working directory does the launch fall back
  // to $HOME — otherwise `resume` would start in the wrong tree.
  const user = userEvent.setup()
  render(
    <ul>
      <SessionRow
        session={{ ...baseSession, workingDir: "  /repos/cognia  " } as ChatSession}
        active={false}
        onSelect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  const item = await screen.findByText("openInTerminal")
  await waitFor(() =>
    expect(item.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled")
  )
  await user.click(item)

  await waitFor(() =>
    expect(mockLaunchCogniaAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repos/cognia" })
    )
  )
})
