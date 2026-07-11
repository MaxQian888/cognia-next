/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { MobileConsentSheet } from "./mobile-consent-sheet"
import type {
  AutomationConsentStream,
  PendingConsent,
} from "@/hooks/automation/use-automation-consent"
import type { ControlCapability } from "@/hooks/data/use-can-control"

let canControl: ControlCapability = true
jest.mock("@/hooks/data/use-can-control", () => ({
  useCanControl: () => canControl,
}))

const respondMock = jest.fn().mockResolvedValue(undefined)
let stream: AutomationConsentStream
jest.mock("@/hooks/automation/use-automation-consent", () => ({
  useAutomationConsent: () => stream,
}))

// Biometric guard — default impl runs the action and reports ok.
let guardImpl: (gate: unknown, action: () => Promise<unknown>) => Promise<unknown>
jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard:
    () => (gate: unknown, action: () => Promise<unknown>) =>
      guardImpl(gate, action),
}))

const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }))

function prompt(overrides: Partial<PendingConsent> = {}): PendingConsent {
  return {
    id: "evt-1",
    command: "click",
    surface: "computerUse",
    pluginId: "cognia-computer-use",
    processName: "notepad.exe",
    windowTitle: "Untitled - Notepad",
    timeoutMs: 30000,
    expiresAt: Date.now() + 30000,
    ...overrides,
  } as PendingConsent
}

function baseStream(queue: PendingConsent[]): AutomationConsentStream {
  return { queue, now: Date.now(), respond: respondMock }
}

beforeEach(() => {
  canControl = true
  respondMock.mockClear().mockResolvedValue(undefined)
  toastErrorMock.mockClear()
  guardImpl = async (_gate, action) => ({ kind: "ok", value: await action() })
  stream = baseStream([])
})

describe("<MobileConsentSheet />", () => {
  it("renders nothing when the device cannot control", () => {
    canControl = false
    stream = baseStream([prompt()])
    const { container } = render(<MobileConsentSheet />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId("mobile-consent-sheet")).not.toBeInTheDocument()
  })

  it("renders nothing when the queue is empty", () => {
    stream = baseStream([])
    render(<MobileConsentSheet />)
    expect(screen.queryByTestId("mobile-consent-sheet")).not.toBeInTheDocument()
  })

  it("renders the prompt with translated command + surface when controllable", () => {
    stream = baseStream([prompt()])
    render(<MobileConsentSheet />)
    expect(screen.getByTestId("mobile-consent-sheet")).toBeInTheDocument()
    expect(screen.getByText("Click on screen")).toBeInTheDocument()
    expect(screen.getByText("Computer Use")).toBeInTheDocument()
    expect(screen.getByText("cognia-computer-use")).toBeInTheDocument()
  })

  it("uses the raw command name when the verb has no translation", () => {
    stream = baseStream([prompt({ command: "experimental_verb" })])
    render(<MobileConsentSheet />)
    expect(screen.getByText("experimental_verb")).toBeInTheDocument()
  })

  it("Allow once runs the biometric guard then responds with persist=false", async () => {
    stream = baseStream([prompt()])
    render(<MobileConsentSheet />)
    fireEvent.click(screen.getByTestId("mobile-consent-allow"))
    await waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-1" }),
        true,
        false
      )
    )
  })

  it("Always allow responds with persist=true", async () => {
    stream = baseStream([prompt()])
    render(<MobileConsentSheet />)
    fireEvent.click(screen.getByTestId("mobile-consent-allow-always"))
    await waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-1" }),
        true,
        true
      )
    )
  })

  it("Reject responds immediately without the biometric guard", async () => {
    const guardSpy = jest.fn()
    guardImpl = async (_gate, action) => {
      guardSpy()
      return { kind: "ok", value: await action() }
    }
    stream = baseStream([prompt()])
    render(<MobileConsentSheet />)
    fireEvent.click(screen.getByTestId("mobile-consent-reject"))
    await waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-1" }),
        false,
        false
      )
    )
    expect(guardSpy).not.toHaveBeenCalled()
  })

  it("rejects the current prompt on Android hardware back (popstate)", async () => {
    stream = baseStream([prompt()])
    render(<MobileConsentSheet />)
    fireEvent.popState(window)
    await waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evt-1" }),
        false,
        false
      )
    )
  })

  it("surfaces a toast and does not respond when the guard blocks (non-cancel)", async () => {
    guardImpl = async () => ({ kind: "blocked", reason: "lockout" })
    stream = baseStream([prompt()])
    render(<MobileConsentSheet />)
    fireEvent.click(screen.getByTestId("mobile-consent-allow"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(respondMock).not.toHaveBeenCalled()
  })
})
