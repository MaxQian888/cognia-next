/**
 * @jest-environment jsdom
 *
 * Covers the "Open in terminal" affordance added to SessionRow (desktop→CLI
 * handoff). Kept separate from session-row.test.tsx so the isTauri=true mock
 * doesn't affect the base suite (which exercises the non-Tauri layout).
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@/lib/claude/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, params?: Record<string, unknown>) =>
    params ? `${k}:${JSON.stringify(params)}` : k,
}))
jest.mock("@/lib/logging", () => ({ loggers: { ui: { info: jest.fn(), warn: jest.fn() } } }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

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

import { SessionRow } from "./session-row"

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

beforeEach(() => jest.clearAllMocks())

test("Open in terminal exports the session transcript and toasts the resume command", async () => {
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("openInTerminal"))

  expect(mockListMessages).toHaveBeenCalledWith("s-1")
  expect(mockExport).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }))
  expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("cognia-agent resume s-1"))
})

test("a failed export surfaces an error toast", async () => {
  mockExport.mockRejectedValueOnce(new Error("no home"))
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("openInTerminal"))
  expect(mockToastError).toHaveBeenCalledWith("openInTerminalFailed")
})
