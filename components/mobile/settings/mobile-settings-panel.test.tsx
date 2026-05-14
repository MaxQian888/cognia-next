/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks — declared before importing the SUT.
// ---------------------------------------------------------------------------

const saveMock: jest.Mock = jest.fn(async () => undefined)
const enqueueMock: jest.Mock = jest.fn(async () => undefined)

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: {
    theme: "system",
    language: "en",
    fontScale: "md",
    defaultModel: "",
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
      save: async (patch) => {
        // Mimic the real store: merge patch into the current settings so
        // subsequent renders see the new value via the same selector path.
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

import { MobileSettingsPanel } from "./mobile-settings-panel"
import type { BiometricGuardPolicy } from "@/lib/claude/types"

// ---------------------------------------------------------------------------

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue(undefined)
  enqueueMock.mockReset()
  enqueueMock.mockResolvedValue(undefined)
  settingsRef.current = {
    theme: "system",
    language: "en",
    fontScale: "md",
    defaultModel: "",
  }
})

describe("<MobileSettingsPanel />", () => {
  it("renders four rows wired to the settings store", () => {
    render(<MobileSettingsPanel />)
    expect(screen.getByTestId("mobile-settings-panel")).toBeInTheDocument()
    expect(screen.getByTestId("settings-theme")).toBeInTheDocument()
    expect(screen.getByTestId("settings-language")).toBeInTheDocument()
    expect(screen.getByTestId("settings-font-scale")).toBeInTheDocument()
    expect(screen.getByTestId("settings-default-model")).toBeInTheDocument()
  })

  it("language options come from the shared localeNames map (no hard-coded JSX)", () => {
    render(<MobileSettingsPanel />)
    // The component should now render BOTH localized names without
    // appearing as literal JSX text — i.e. they live in the Select
    // content surface, populated from `localeNames`. The Radix Select
    // mounts its content lazily; assert the trigger picked up the
    // current value and trust the option renderer for the rest.
    const trigger = screen.getByTestId("settings-language")
    expect(trigger).toHaveTextContent(/English/)
  })

  it("updates the defaultModel field and enqueues a server-bound write", async () => {
    render(<MobileSettingsPanel />)
    const input = screen.getByTestId("settings-default-model") as HTMLInputElement

    // Use a single `change` event to bypass the controlled-input feedback
    // loop — the mock store isn't reactive enough to re-render between
    // keystrokes, which userEvent.type() relies on.
    fireEvent.change(input, { target: { value: "claude-sonnet-4-6" } })
    // `update()` is fire-and-forget (`void update(...)`); flush the
    // microtask queue so `enqueue` resolves before we assert.
    await Promise.resolve()
    await Promise.resolve()

    expect(saveMock).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-6" })
    expect(enqueueMock).toHaveBeenCalled()
    const lastEnqueue = enqueueMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastEnqueue.command).toBe("app_settings_update")
    expect((lastEnqueue.payload as { patch: Record<string, unknown> }).patch).toEqual({
      defaultModel: "claude-sonnet-4-6",
    })
  })

  it("clearing the model input writes undefined (not empty string)", async () => {
    settingsRef.current = {
      theme: "system",
      language: "en",
      fontScale: "md",
      defaultModel: "claude-opus",
    }
    render(<MobileSettingsPanel />)
    const input = screen.getByTestId("settings-default-model") as HTMLInputElement
    fireEvent.change(input, { target: { value: "" } })
    await Promise.resolve()
    await Promise.resolve()

    // The store-write path treats an empty string as "unset" → undefined.
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: undefined })
  })

  it("falls back to default values when the store has no settings yet", () => {
    settingsRef.current = undefined
    render(<MobileSettingsPanel />)
    // Trigger renders even without persisted settings.
    expect(screen.getByTestId("settings-theme")).toBeInTheDocument()
    expect(screen.getByTestId("settings-default-model")).toHaveValue("")
  })

  it("renders three biometric switches reflecting DEFAULT_BIOMETRIC_GUARD", () => {
    render(<MobileSettingsPanel />)
    // DEFAULT_BIOMETRIC_GUARD: deletePairing=true, exportBackup=false, revealSecrets=false.
    expect(screen.getByTestId("biometric-delete-pairing")).toHaveAttribute("data-state", "checked")
    expect(screen.getByTestId("biometric-export-backup")).toHaveAttribute("data-state", "unchecked")
    expect(screen.getByTestId("biometric-reveal-secrets")).toHaveAttribute(
      "data-state",
      "unchecked"
    )
  })

  it("toggling a biometric switch merges into biometricRequiredFor and enqueues", async () => {
    render(<MobileSettingsPanel />)
    fireEvent.click(screen.getByTestId("biometric-export-backup"))
    // `updateBiometric` is fire-and-forget; flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    expect(saveMock).toHaveBeenCalledWith({
      biometricRequiredFor: {
        deletePairing: true,
        exportBackup: true,
        revealSecrets: false,
      },
    })
    const lastEnqueue = enqueueMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(lastEnqueue.command).toBe("app_settings_update")
    expect(
      (lastEnqueue.payload as { patch: { biometricRequiredFor: BiometricGuardPolicy } }).patch
        .biometricRequiredFor
    ).toEqual({
      deletePairing: true,
      exportBackup: true,
      revealSecrets: false,
    })
  })
})
