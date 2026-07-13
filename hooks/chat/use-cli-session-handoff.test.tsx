/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"

jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@cognia/logging", () => ({
  loggers: { shell: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params?.title ? `${key}:${params.title}` : key,
}))

// Default: echo the incoming sessionId as the created row's id (the common
// no-collision case). Tests that exercise the id-divert path override this.
const mockImport = jest.fn(async (arg?: { sessionId?: string }) => ({ id: arg?.sessionId }))
jest.mock("@/lib/chat/import-handoff-session", () => ({
  importHandoffSession: (arg: unknown) => mockImport(arg as { sessionId?: string }),
}))

const mockSetActive = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => ({ setActiveSession: mockSetActive }) },
}))

const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (msg: unknown) => mockToastSuccess(msg),
    error: (msg: unknown) => mockToastError(msg),
  },
}))

import { listen } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"
import { useCliSessionHandoff, SESSION_HANDOFF_EVENT } from "./use-cli-session-handoff"

const mockListen = listen as jest.MockedFunction<typeof listen>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

type Cb = (event: { payload: unknown }) => void
let captured: Cb | undefined

function Harness() {
  useCliSessionHandoff()
  return null
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  jest.clearAllMocks()
  captured = undefined
  mockIsTauri.mockReturnValue(true)
  mockListen.mockImplementation(((name: string, cb: Cb) => {
    if (name === SESSION_HANDOFF_EVENT) captured = cb
    return Promise.resolve(jest.fn())
  }) as unknown as typeof listen)
})

it("imports the handed-off session and activates it", async () => {
  await act(async () => {
    render(<Harness />)
    await flush()
  })
  expect(captured).toBeDefined()
  await act(async () => {
    captured!({
      payload: {
        sessionId: "s_cli_1",
        title: "Fix bug",
        messages: [{ role: "user", content: "hi" }],
        meta: { provider: "anthropic" },
      },
    })
    await flush()
  })
  expect(mockImport).toHaveBeenCalledWith({
    sessionId: "s_cli_1",
    title: "Fix bug",
    messages: [{ role: "user", content: "hi" }],
    meta: { provider: "anthropic" },
  })
  expect(mockSetActive).toHaveBeenCalledWith("s_cli_1")
  expect(mockToastSuccess).toHaveBeenCalledWith("received:Fix bug")
})

it("activates the id the import returned, not the CLI id (collision divert)", async () => {
  // The import diverted to a fresh id because the CLI id collided with a
  // native session; the hook must open the row that was actually written.
  mockImport.mockResolvedValueOnce({ id: "s_fresh_9" })
  await act(async () => {
    render(<Harness />)
    await flush()
  })
  await act(async () => {
    captured!({ payload: { sessionId: "s_cli_x", messages: [{ role: "user", content: "hi" }] } })
    await flush()
  })
  expect(mockSetActive).toHaveBeenCalledWith("s_fresh_9")
  expect(mockSetActive).not.toHaveBeenCalledWith("s_cli_x")
})

it("ignores a payload with no sessionId", async () => {
  await act(async () => {
    render(<Harness />)
    await flush()
  })
  await act(async () => {
    captured!({ payload: { messages: [] } })
    await flush()
  })
  expect(mockImport).not.toHaveBeenCalled()
})

it("shows an error toast when import fails", async () => {
  mockImport.mockRejectedValueOnce(new Error("dexie boom"))
  await act(async () => {
    render(<Harness />)
    await flush()
  })
  await act(async () => {
    captured!({ payload: { sessionId: "s1", messages: [] } })
    await flush()
  })
  expect(mockToastError).toHaveBeenCalledWith("failed")
  expect(mockSetActive).not.toHaveBeenCalled()
})

it("is a no-op outside Tauri", async () => {
  mockIsTauri.mockReturnValue(false)
  await act(async () => {
    render(<Harness />)
    await flush()
  })
  expect(mockListen).not.toHaveBeenCalled()
})
