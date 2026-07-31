/** @jest-environment jsdom */

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ConsentOverlay } from "./consent-overlay"
import { isTauri } from "@/lib/tauri"
import { desktop } from "@/lib/automation/client"
// Use the real event shape rather than a local copy — a hand-maintained
// duplicate silently stops catching drift the moment the wire type grows a
// field (as it did when the grant key gained `sessionKey`). `import type` is
// erased, so it survives the module mock below.
import type { ConsentRequestEvent } from "@/lib/automation/client"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

const mockListen = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    consentRespond: jest.fn().mockResolvedValue(undefined),
  },
}))

const mockedConsentRespond = (desktop as unknown as { consentRespond: jest.Mock }).consentRespond

beforeEach(() => {
  jest.clearAllMocks()
})

function setupListener() {
  let onEvent: ((event: { payload: ConsentRequestEvent }) => void) | null = null
  mockListen.mockImplementation(
    async (_eventName: string, handler: (e: { payload: ConsentRequestEvent }) => void) => {
      onEvent = handler
      return jest.fn()
    }
  )
  const fire = (payload: ConsentRequestEvent) => {
    if (!onEvent) throw new Error("listener not registered yet")
    act(() => onEvent!({ payload }))
  }
  return { fire }
}

describe("ConsentOverlay", () => {
  it("survives an unlisten that throws during unmount cleanup (Tauri unlisten race)", async () => {
    mockedIsTauri.mockReturnValue(true)
    // Mirrors tauri 2.x `unregisterListener` throwing
    // `listeners[eventId].handlerId` when the registration eval lost the race.
    const throwingUnlisten = jest.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
    })
    mockListen.mockResolvedValue(throwingUnlisten)
    const { unmount } = render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(() => unmount()).not.toThrow()
    expect(throwingUnlisten).toHaveBeenCalledTimes(1)
  })

  it("disposes a listener that resolves only after unmount", async () => {
    mockedIsTauri.mockReturnValue(true)
    const throwingUnlisten = jest.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
    })
    let resolveListen: ((u: () => void) => void) | null = null
    mockListen.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve
        })
    )
    const { unmount } = render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => {
      resolveListen!(throwingUnlisten)
    })
    // The cancelled path must still dispose the late listener — and swallow
    // its throw instead of surfacing an unhandled rejection.
    expect(throwingUnlisten).toHaveBeenCalledTimes(1)
  })

  it("renders nothing on web mode", () => {
    mockedIsTauri.mockReturnValue(false)
    const { container } = render(<ConsentOverlay />)
    expect(container.firstChild).toBeNull()
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("renders the prompt + i18n-wired action buttons on desktop", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-1",
      command: "click",
      surface: "computerUse",
      pluginId: "cognia-computer-use",
      processName: "notepad.exe",
      windowTitle: "Untitled - Notepad",
      timeoutMs: 30000,
    })

    expect(screen.getByText("Automation requests your consent")).toBeInTheDocument()
    expect(screen.getByText("Click on screen")).toBeInTheDocument()
    expect(screen.getByText("Computer Use")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument()
    expect(screen.getByText("Stop asking for:")).toBeInTheDocument()
    for (const minutes of [15, 30, 60]) {
      expect(screen.getByRole("button", { name: `${minutes} min` })).toBeInTheDocument()
    }
  })

  it("renders the command detail block for a shell-class action", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-bash",
      command: "bash",
      surface: "computerUse",
      pluginId: "cognia-computer-use",
      processName: null,
      windowTitle: null,
      commandDetail: "rm -rf /tmp/x && echo done",
      timeoutMs: 30000,
    })

    expect(screen.getByText("Command:")).toBeInTheDocument()
    expect(screen.getByText("rm -rf /tmp/x && echo done")).toBeInTheDocument()
  })

  it("omits the command detail block when absent", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-click2",
      command: "click",
      surface: "computerUse",
      pluginId: null,
      processName: null,
      windowTitle: null,
      timeoutMs: 30000,
    })

    expect(screen.queryByText("Command:")).not.toBeInTheDocument()
  })

  it("uses raw command name when the verb has no translation entry", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-unknown",
      command: "experimental_unknown_verb",
      surface: "plugin",
      pluginId: null,
      processName: null,
      windowTitle: null,
      timeoutMs: 30000,
    })

    expect(screen.getByText("experimental_unknown_verb")).toBeInTheDocument()
  })

  it("Allow once invokes consentRespond with persist=false", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-allow",
      command: "click",
      surface: "computerUse",
      pluginId: null,
      processName: null,
      windowTitle: null,
      timeoutMs: 30000,
    })

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await waitFor(() =>
      expect(mockedConsentRespond).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-allow", allow: true, persist: false })
      )
    )
  })

  it("a timed grant sends the prompt back so the broker can register it", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-session",
      command: "click",
      surface: "computerUse",
      pluginId: "cognia-computer-use",
      processName: "notepad.exe",
      windowTitle: "Notepad",
      sessionKey: "session-a",
      timeoutMs: 90000,
    })

    fireEvent.click(screen.getByRole("button", { name: "30 min" }))
    await waitFor(() =>
      expect(mockedConsentRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "evt-session",
          allow: true,
          persist: true,
          grantDurationMs: 30 * 60_000,
          prompt: expect.objectContaining({
            command: "click",
            surface: "computerUse",
            pluginId: "cognia-computer-use",
            // Part of the host's grant key — dropping it would register the
            // grant under an empty session tag and it would never match.
            sessionKey: "session-a",
          }),
        })
      )
    )
  })

  it("each duration button asks for its own window", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-15",
      command: "click",
      surface: "computerUse",
      pluginId: null,
      processName: null,
      windowTitle: null,
      timeoutMs: 90000,
    })

    fireEvent.click(screen.getByRole("button", { name: "15 min" }))
    await waitFor(() =>
      expect(mockedConsentRespond).toHaveBeenCalledWith(
        expect.objectContaining({ grantDurationMs: 15 * 60_000 })
      )
    )
  })

  it("Allow once carries no grant duration", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-once-nogrant",
      command: "click",
      surface: "computerUse",
      pluginId: null,
      processName: null,
      windowTitle: null,
      timeoutMs: 90000,
    })

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await waitFor(() =>
      expect(mockedConsentRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          persist: false,
          grantDurationMs: undefined,
          prompt: undefined,
        })
      )
    )
  })

  it("Reject sends allow=false", async () => {
    mockedIsTauri.mockReturnValue(true)
    const { fire } = setupListener()
    render(<ConsentOverlay />)
    await waitFor(() => expect(mockListen).toHaveBeenCalledTimes(1))

    fire({
      id: "evt-reject",
      command: "click",
      surface: "computerUse",
      pluginId: null,
      processName: null,
      windowTitle: null,
      timeoutMs: 30000,
    })

    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    await waitFor(() =>
      expect(mockedConsentRespond).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-reject", allow: false, persist: false })
      )
    )
  })
})
