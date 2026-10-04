/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)
const mockTrackEvent = jest.fn().mockResolvedValue(true)
const mockIsMobile = jest.fn(() => false)
const mockGuard = jest.fn()
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  isMobile: () => mockIsMobile(),
}))
jest.mock("@/hooks/use-biometric-guard", () => ({ useBiometricGuard: () => mockGuard }))

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: {
    fontScale: "md",
    defaultModel: "",
    biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (
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
    { getState: () => ({ settings: settingsRef.current }) }
  ),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

// Render the Radix Select as a native <select> so `onValueChange` is testable.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[], meta: { testid?: string }) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.props["data-testid"]) meta.testid = child.props["data-testid"] as string
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items, meta)
      }
    )
  }
  const Select = ({ value, onValueChange, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    const meta: { testid?: string } = {}
    collect(children, items as unknown[], meta)
    return React.createElement(
      "select",
      {
        "data-testid": meta.testid,
        value,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: string) => void)(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props.value, value: it.props.value },
          it.props.children
        )
      )
    )
  }
  const SelectTrigger = () => null
  const SelectValue = () => null
  const SelectContent = ({ children }: { children: unknown }) => children
  const SelectItem = (props: unknown) => props
  ;(SelectItem as { __isItem?: boolean }).__isItem = true
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  mockTrackEvent.mockClear()
  mockIsMobile.mockReturnValue(false)
  mockGuard.mockReset()
  settingsRef.current = {
    fontScale: "md",
    defaultModel: "",
    biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
  }
  localStorage.clear()
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

  it("renders the accessibility & privacy toggles", () => {
    render(<Page />)
    expect(screen.getByTestId("pref-reduce-motion")).toBeInTheDocument()
    expect(screen.getByTestId("pref-telemetry")).toBeInTheDocument()
  })

  it("toggling reduce-motion persists and enqueues a server-bound update", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-reduce-motion"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ reduceMotion: true })
    // Host mirroring moved out of `useSettingsPatch` and into the persistence
    // funnel (`lib/settings/mirror-to-host.ts`) so it also covers the mobile
    // routes that embed a desktop settings section. Enqueuing here as well
    // would send every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("toggling telemetry persists the new value", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-telemetry"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      telemetryEnabled: true,
      behaviorTelemetry: expect.objectContaining({ enabled: true }),
    })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: true })
    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: true })
  })

  it("records opt-out before disabling the real consent", async () => {
    localStorage.setItem("cognia-behavior-telemetry-enabled", "true")
    settingsRef.current = {
      ...settingsRef.current,
      telemetryEnabled: true,
      behaviorTelemetry: { enabled: true },
    }
    render(<Page />)

    fireEvent.click(screen.getByTestId("pref-telemetry"))
    await Promise.resolve()
    await Promise.resolve()

    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: false })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: false })
  })

  it("migrates an enabled legacy telemetry preference into the real consent", () => {
    settingsRef.current = {
      fontScale: "md",
      defaultModel: "",
      telemetryEnabled: true,
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
    }

    render(<Page />)

    expect(screen.getByTestId("pref-telemetry")).toHaveAttribute("aria-checked", "true")
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: true })
  })

  it("writes the default model once, on blur, not per keystroke", async () => {
    render(<Page />)
    const input = screen.getByTestId("pref-default-model")
    // Each save mirrors to a paired desktop as its own queued job, so typing
    // must not write "c", "cl", "cla", …
    fireEvent.change(input, { target: { value: "claude" } })
    fireEvent.change(input, { target: { value: "claude-sonnet-4-6 " } })
    expect(saveMock).not.toHaveBeenCalled()
    expect(input).toHaveValue("claude-sonnet-4-6 ")
    fireEvent.blur(input)
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-6" })
    // Host mirroring moved out of `useSettingsPatch` and into the persistence
    // funnel (`lib/settings/mirror-to-host.ts`) so it also covers the mobile
    // routes that embed a desktop settings section. Enqueuing here as well
    // would send every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("toggling the sign-out biometric switch persists the new policy", async () => {
    render(<Page />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("pref-biometric-sign-out"))
    })
    expect(saveMock).toHaveBeenCalledWith({
      biometricRequiredFor: {
        ...DEFAULT_BIOMETRIC_GUARD,
        signOut: false,
      },
    })
  })

  it("keeps the mobile preference unchanged when verification is cancelled", async () => {
    mockIsMobile.mockReturnValue(true)
    mockGuard.mockResolvedValue({ kind: "blocked", reason: "cancelled" })
    render(<Page />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("pref-biometric-sign-out"))
    })
    expect(mockGuard.mock.calls[0][0]).toMatchObject({ fallthroughWhenUnavailable: false })
    expect(saveMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("pref-biometric-sign-out")).toHaveAttribute("aria-checked", "true")
  })

  it("persists the mobile preference only after verified identity", async () => {
    mockIsMobile.mockReturnValue(true)
    mockGuard.mockImplementation(async (_gate, action) => ({ kind: "ok", value: await action() }))
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-biometric-sign-out"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD, signOut: false },
      })
    )
    expect(mockGuard).toHaveBeenCalledTimes(1)
  })

  it("changing the font scale persists the new value", async () => {
    render(<Page />)
    fireEvent.change(screen.getByTestId("pref-font-scale"), { target: { value: "lg" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ fontScale: "lg" })
  })

  it.each([
    ["pref-biometric-delete-pairing", "deletePairing"],
    ["pref-biometric-export-backup", "exportBackup"],
    ["pref-biometric-reveal-secrets", "revealSecrets"],
  ] as const)("toggling %s merge-updates the guard", async (testid, key) => {
    const { unmount } = render(<Page />)
    await act(async () => {
      fireEvent.click(screen.getByTestId(testid))
    })
    expect(saveMock).toHaveBeenCalledWith({
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD, [key]: !DEFAULT_BIOMETRIC_GUARD[key] },
    })
    unmount()
  })

  it("clearing the default model writes undefined (not an empty string)", async () => {
    settingsRef.current = {
      fontScale: "md",
      defaultModel: "claude-opus-4-8",
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
    }
    render(<Page />)
    fireEvent.change(screen.getByTestId("pref-default-model"), { target: { value: "" } })
    fireEvent.blur(screen.getByTestId("pref-default-model"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: undefined })
  })

  it("commits the default model on Enter, and skips an unchanged value", async () => {
    settingsRef.current = {
      fontScale: "md",
      defaultModel: "claude-opus-4-8",
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
    }
    render(<Page />)
    const input = screen.getByTestId("pref-default-model")
    fireEvent.change(input, { target: { value: " claude-opus-4-8 " } })
    fireEvent.blur(input)
    await Promise.resolve()
    expect(saveMock).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "claude-haiku-4-5" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: "claude-haiku-4-5" })
  })

  it("falls back to safe defaults when settings are absent", () => {
    settingsRef.current = undefined
    render(<Page />)
    expect(screen.getByTestId("pref-reduce-motion")).not.toBeChecked()
    expect(screen.getByTestId("pref-telemetry")).not.toBeChecked()
    expect(screen.getByTestId("pref-biometric-sign-out")).toBeInTheDocument()
  })
})
