/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn()
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockedSettings, save: saveMock }),
}))

const guardMock = jest.fn()
jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: () => guardMock,
}))

import { SecuritySection } from "./security-section"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"

beforeEach(() => {
  saveMock.mockReset()
  guardMock.mockReset()
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

  it("toggling the signOut row persists the merged policy patch", () => {
    render(<SecuritySection />)
    const signOut = screen.getByTestId("biometric-sign-out").querySelector("button")!
    fireEvent.click(signOut)
    expect(saveMock).toHaveBeenCalledTimes(1)
    const patch = saveMock.mock.calls[0][0]
    // signOut defaults to true → toggling sends false, other keys preserved.
    expect(patch.biometricRequiredFor).toEqual({
      ...DEFAULT_BIOMETRIC_GUARD,
      signOut: false,
    })
  })

  it("invokes the biometric guard on the test button", () => {
    render(<SecuritySection />)
    fireEvent.click(screen.getByTestId("biometric-test"))
    expect(guardMock).toHaveBeenCalledTimes(1)
    expect(guardMock.mock.calls[0][0]).toMatchObject({ fallthroughWhenUnavailable: false })
  })
})
