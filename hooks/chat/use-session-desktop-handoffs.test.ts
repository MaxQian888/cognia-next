/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"
import type { MouseEvent as ReactMouseEvent } from "react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

const detectCli = jest.fn()
jest.mock("@/lib/cli-bridge/detect-cli", () => ({
  detectCli: (name: string) => detectCli(name),
}))

const dispatchToCodex = jest.fn()
const returnFromCodex = jest.fn()
jest.mock("@/lib/chat/dispatch-to-codex-app", () => ({
  dispatchSessionToCodexApp: (session: ChatSession) => dispatchToCodex(session),
  returnSessionFromCodexApp: (session: ChatSession) => returnFromCodex(session),
}))

const listMessages = jest.fn()
jest.mock("@/lib/db/messages", () => ({ listMessages: (id: string) => listMessages(id) }))
const exportHandoff = jest.fn()
jest.mock("@/lib/chat/export-handoff-to-cli", () => ({
  exportHandoffToCli: (input: unknown) => exportHandoff(input),
}))
const launchAgent = jest.fn()
jest.mock("@/lib/terminal/run-cognia", () => ({
  launchCogniaAgent: (input: unknown) => launchAgent(input),
}))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ marker: "terminal-store" }) },
}))
jest.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }))

import { useSessionDesktopHandoffs } from "./use-session-desktop-handoffs"

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({ id: "s1", title: "Hello", kind: "direct", createdAt: 1, updatedAt: 1, ...over }) as ChatSession

beforeEach(() => {
  tauri = true
  for (const mock of [
    toastSuccess,
    toastError,
    detectCli,
    dispatchToCodex,
    returnFromCodex,
    listMessages,
    exportHandoff,
    launchAgent,
  ]) {
    mock.mockReset()
  }
  listMessages.mockResolvedValue([])
  exportHandoff.mockResolvedValue(undefined)
})

describe("useSessionDesktopHandoffs", () => {
  it("offers no desktop group and probes nothing off the desktop shell", () => {
    tauri = false
    const { result } = renderHook(() => useSessionDesktopHandoffs(session(), jest.fn()))
    expect(result.current.desktop).toBeUndefined()
    act(() => result.current.onActionsOpenChange(true))
    expect(detectCli).not.toHaveBeenCalled()
  })

  it("probes the CLI once when a menu opens, and reports what it found", async () => {
    detectCli.mockResolvedValue({ available: true })
    const { result } = renderHook(() => useSessionDesktopHandoffs(session(), jest.fn()))
    expect(result.current.desktop?.cogniaAgentStatus).toBe("unknown")
    act(() => result.current.onActionsOpenChange(true))
    await waitFor(() => expect(result.current.desktop?.cogniaAgentStatus).toBe("available"))
    act(() => result.current.onActionsOpenChange(true))
    expect(detectCli).toHaveBeenCalledTimes(1)
    expect(detectCli).toHaveBeenCalledWith("cognia-agent")
  })

  it("reads a failed probe as a missing CLI", async () => {
    detectCli.mockRejectedValue(new Error("no shell"))
    const { result } = renderHook(() => useSessionDesktopHandoffs(session(), jest.fn()))
    act(() => result.current.onActionsOpenChange(true))
    await waitFor(() => expect(result.current.desktop?.cogniaAgentStatus).toBe("missing"))
  })

  it("hands the conversation to the terminal with its transcript", async () => {
    launchAgent.mockResolvedValue({ kind: "launched" })
    const { result } = renderHook(() =>
      useSessionDesktopHandoffs(session({ workingDir: "/repo" }), jest.fn())
    )
    act(() => result.current.desktop!.onOpenInTerminal())
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(exportHandoff).toHaveBeenCalledWith({ sessionId: "s1", messages: [] })
    expect(launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ handoffSessionId: "s1", cwd: "/repo" })
    )
  })

  it("says so when the terminal launch is refused", async () => {
    launchAgent.mockResolvedValue({ kind: "denied", reason: "no" })
    const { result } = renderHook(() => useSessionDesktopHandoffs(session(), jest.fn()))
    act(() => result.current.desktop!.onOpenInTerminal())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("openInTerminalFailed"))
  })

  it("dispatches to Codex and settles the busy flag either way", async () => {
    dispatchToCodex.mockResolvedValue({ threadId: "t" })
    const { result } = renderHook(() => useSessionDesktopHandoffs(session(), jest.fn()))
    act(() => result.current.desktop!.onOpenInCodexApp())
    expect(result.current.desktop?.codexDispatching).toBe(true)
    await waitFor(() => expect(result.current.desktop?.codexDispatching).toBe(false))
    expect(toastSuccess).toHaveBeenCalledWith("openedInCodexApp")

    dispatchToCodex.mockRejectedValue(Object.assign(new Error("pii"), { code: "PII_BLOCKED" }))
    act(() => result.current.desktop!.onOpenInCodexApp())
    await waitFor(() => expect(result.current.desktop?.codexDispatching).toBe(false))
    expect(toastError).toHaveBeenCalledWith("codexHandoffPiiBlocked", expect.anything())
  })

  it("offers the return only for a conversation handed to Codex, and opens where it lands", async () => {
    const onReturned = jest.fn()
    const { result, rerender } = renderHook(
      ({ row }: { row: ChatSession }) => useSessionDesktopHandoffs(row, onReturned),
      { initialProps: { row: session() } }
    )
    expect(result.current.desktop?.onReturnFromCodexApp).toBeUndefined()
    rerender({ row: session({ codexHandoff: { threadId: "t" } as ChatSession["codexHandoff"] }) })
    returnFromCodex.mockResolvedValue("s-back")
    const event = {} as ReactMouseEvent
    act(() => result.current.desktop!.onReturnFromCodexApp!(event))
    await waitFor(() => expect(onReturned).toHaveBeenCalledWith("s-back", event))
    expect(toastSuccess).toHaveBeenCalledWith("returnedFromCodexApp")
  })
})
