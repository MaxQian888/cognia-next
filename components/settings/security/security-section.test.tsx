/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn()
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    <T,>(selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T) =>
      selector({ settings: mockedSettings, save: saveMock }),
    {
      getState: () => ({ settings: mockedSettings, save: saveMock }),
    }
  ),
}))
const mockIsMobile = jest.fn(() => false)
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  isMobile: () => mockIsMobile(),
}))
const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

const guardMock = jest.fn()
jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => guardMock,
}))
jest.mock("@/components/governance/context-inspector", () => ({
  ContextInspector: () => <div data-testid="context-inspector" />,
}))

import { SecuritySection } from "./security-section"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"

beforeEach(() => {
  saveMock.mockReset()
  guardMock.mockReset()
  guardMock.mockImplementation(async (_gate, action) => ({ kind: "ok", value: await action() }))
  mockIsMobile.mockReturnValue(false)
  mockToastSuccess.mockClear()
  mockToastError.mockClear()
  mockedSettings = {}
})

describe("SecuritySection", () => {
  it("renders all four biometric guard rows including signOut", () => {
    render(<SecuritySection />)
    expect(screen.getByTestId("biometric-delete-pairing")).toBeInTheDocument()
    expect(screen.getByTestId("biometric-export-backup")).toBeInTheDocument()
    expect(screen.getByTestId("biometric-reveal-secrets")).toBeInTheDocument()
    expect(screen.getByTestId("biometric-sign-out")).toBeInTheDocument()
    expect(screen.getAllByRole("switch")).toHaveLength(4)
    expect(screen.getByTestId("context-inspector")).toBeInTheDocument()
  })

  it("reflects the persisted policy in switch state", () => {
    mockedSettings = {
      biometricRequiredFor: {
        deletePairing: false,
        exportBackup: true,
        revealSecrets: false,
        signOut: false,
      },
    }
    render(<SecuritySection />)
    const switches = screen.getAllByRole("switch")
    // Order matches GUARD_ROWS: deletePairing, exportBackup, revealSecrets, signOut.
    expect(switches[0]).toHaveAttribute("aria-checked", "false")
    expect(switches[1]).toHaveAttribute("aria-checked", "true")
    expect(switches[3]).toHaveAttribute("aria-checked", "false")
  })

  it("toggling the signOut row persists the merged policy patch", async () => {
    render(<SecuritySection />)
    const signOut = screen.getByTestId("biometric-sign-out").querySelector("button")!
    await act(async () => {
      fireEvent.click(signOut)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    const patch = saveMock.mock.calls[0][0]
    // signOut defaults to true → toggling sends false, other keys preserved.
    expect(patch.biometricRequiredFor).toEqual({
      ...DEFAULT_BIOMETRIC_GUARD,
      signOut: false,
    })
  })

  it("invokes the biometric guard on the test button", async () => {
    render(<SecuritySection />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("biometric-test"))
    })
    expect(guardMock).toHaveBeenCalledTimes(1)
    expect(guardMock.mock.calls[0][0]).toMatchObject({ fallthroughWhenUnavailable: false })
  })

  it.each(["cancelled", "unavailable", "lockout", "error"])(
    "keeps native protection enabled after %s",
    async (reason) => {
      mockIsMobile.mockReturnValue(true)
      guardMock.mockResolvedValue({ kind: "blocked", reason })
      render(<SecuritySection />)
      fireEvent.click(screen.getByTestId("biometric-sign-out").querySelector("button")!)
      await waitFor(() => expect(guardMock).toHaveBeenCalledTimes(1))
      expect(guardMock.mock.calls[0][0]).toMatchObject({ fallthroughWhenUnavailable: false })
      expect(saveMock).not.toHaveBeenCalled()
    }
  )

  it("saves native policy only after successful verification", async () => {
    mockIsMobile.mockReturnValue(true)
    render(<SecuritySection />)
    fireEvent.click(screen.getByTestId("biometric-sign-out").querySelector("button")!)
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD, signOut: false },
      })
    )
    expect(guardMock).toHaveBeenCalledTimes(1)
  })

  it("holds the test button during verification and reports success", async () => {
    let finish!: (outcome: unknown) => void
    guardMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<SecuritySection />)
    const button = screen.getByTestId("biometric-test")
    fireEvent.click(button)
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(guardMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ kind: "ok", value: undefined })
    })
    expect(button).toBeEnabled()
    expect(mockToastSuccess).toHaveBeenCalledWith("testSuccess")
  })

  it.each(["unavailable", "lockout", "error"])("reports a %s test failure", async (reason) => {
    guardMock.mockResolvedValue({ kind: "blocked", reason })
    render(<SecuritySection />)
    fireEvent.click(screen.getByTestId("biometric-test"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("testBlocked"))
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it("defaults the auto-lock select to Off and persists a chosen interval", () => {
    render(<SecuritySection />)
    const select = screen.getByTestId("account-auto-lock-select") as HTMLSelectElement
    expect(select.value).toBe("0")

    fireEvent.change(select, { target: { value: "15" } })
    expect(saveMock).toHaveBeenCalledWith({ accountAutoLockMinutes: 15 })
  })

  it("reflects the persisted auto-lock interval", () => {
    mockedSettings = { accountAutoLockMinutes: 30 }
    render(<SecuritySection />)
    expect((screen.getByTestId("account-auto-lock-select") as HTMLSelectElement).value).toBe("30")
  })
})
