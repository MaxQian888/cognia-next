/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: {
    fontScale: "md",
    defaultModel: "",
    biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown> | undefined
      save: (patch: Record<string, unknown>) => Promise<void>
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      save: async (patch: Record<string, unknown>) => {
        if (settingsRef.current) {
          settingsRef.current = { ...settingsRef.current, ...patch }
        }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  settingsRef.current = {
    fontScale: "md",
    defaultModel: "",
    biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
  }
})

describe("MobilePreferencesPage", () => {
  it("renders font-scale + default-model + four biometric rows", () => {
    render(<Page />)
    expect(screen.getByTestId("pref-font-scale")).toBeInTheDocument()
    expect(screen.getByTestId("pref-default-model")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-delete-pairing")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-export-backup")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-reveal-secrets")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-sign-out")).toBeInTheDocument()
  })

  it("writes the default model patch and enqueues a server-bound update", async () => {
    render(<Page />)
    fireEvent.change(screen.getByTestId("pref-default-model"), {
      target: { value: "claude-sonnet-4-6" },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-6" })
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("toggling the sign-out biometric switch persists the new policy", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-biometric-sign-out"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      biometricRequiredFor: {
        ...DEFAULT_BIOMETRIC_GUARD,
        signOut: false,
      },
    })
  })
})
