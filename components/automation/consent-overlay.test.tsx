/** @jest-environment jsdom */

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ConsentOverlay } from "./consent-overlay"
import { isTauri } from "@/lib/tauri"
import { desktop } from "@/lib/automation/client"

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

interface ConsentRequestEvent {
  id: string
  command: string
  surface: "workflow" | "computerUse" | "mcp" | "plugin"
  pluginId: string | null
  processName: string | null
  windowTitle: string | null
  timeoutMs: number
}

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
    expect(screen.getByRole("button", { name: "Always allow this session" })).toBeInTheDocument()
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

  it("Always allow this session sends the prompt back so the broker can register the grant", async () => {
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
      timeoutMs: 30000,
    })

    fireEvent.click(screen.getByRole("button", { name: "Always allow this session" }))
    await waitFor(() =>
      expect(mockedConsentRespond).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "evt-session",
          allow: true,
          persist: true,
          prompt: expect.objectContaining({
            command: "click",
            surface: "computerUse",
            pluginId: "cognia-computer-use",
          }),
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
