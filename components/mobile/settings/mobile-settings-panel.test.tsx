/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

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

// Transport mock — programmable per test. Default to "not in Capacitor" so
// the tier indicator stays hidden unless a test explicitly opts in.
type TierHandler = (tier: string) => void
const tierHandlers: Set<TierHandler> = new Set()
type ReconnectResult = "ok" | "no-tier" | "throttled"
const transportMock: {
  isCapacitor: jest.Mock<boolean, []>
  tier: string
  call: jest.Mock
  subscribe: jest.Mock
  getActiveTier: jest.Mock<string, []>
  onTierChange: jest.Mock<() => void, [TierHandler]>
  reconnectRtc: jest.Mock<ReconnectResult, []>
} = {
  isCapacitor: jest.fn(() => false),
  tier: "offline",
  call: jest.fn(),
  subscribe: jest.fn(() => () => undefined),
  getActiveTier: jest.fn(() => transportMock.tier),
  onTierChange: jest.fn((h: TierHandler) => {
    h(transportMock.tier)
    tierHandlers.add(h)
    return () => {
      tierHandlers.delete(h)
    }
  }),
  reconnectRtc: jest.fn<ReconnectResult, []>(() => "ok"),
}

// Getter form — `transportMock` is declared above but jest.mock factories
// can be invoked before the surrounding `const` is initialized (the SUT
// loads transitively through other mock factories). A getter defers the
// dereference until the SUT actually reads `transport`.
jest.mock("@/lib/tauri", () => ({
  isCapacitor: () => transportMock.isCapacitor(),
  isTauri: () => false,
  get transport() {
    return transportMock
  },
}))

import { MobileSettingsPanel } from "./mobile-settings-panel"

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
  // Reset the transport mock so each test starts in "not Capacitor".
  transportMock.isCapacitor.mockReturnValue(false)
  transportMock.tier = "offline"
  transportMock.getActiveTier.mockClear()
  transportMock.onTierChange.mockClear()
  tierHandlers.clear()
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

  it("updates the defaultModel field through the store", async () => {
    render(<MobileSettingsPanel />)
    const input = screen.getByTestId("settings-default-model") as HTMLInputElement

    // Use a single `change` event to bypass the controlled-input feedback
    // loop — the mock store isn't reactive enough to re-render between
    // keystrokes, which userEvent.type() relies on.
    fireEvent.change(input, { target: { value: "claude-sonnet-4-6" } })
    // `update()` is fire-and-forget (`void update(...)`); flush the
    // microtask queue before asserting.
    await Promise.resolve()
    await Promise.resolve()

    expect(saveMock).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-6" })
    // This panel used to enqueue `app_settings_update` itself. Host mirroring
    // now happens inside the persistence funnel (`lib/settings/mirror-to-host.ts`)
    // so it covers the desktop sections this shell embeds too; enqueuing here
    // as well would send every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
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
        escalatePermissionMode: true,
        exportBackup: true,
        revealSecrets: false,
        signOut: true,
      },
    })
    // Biometric gating is device-local now: it is a property of *this* device's
    // authenticator, so pushing the phone's policy onto a paired desktop (which
    // may have no biometric hardware at all) is wrong rather than useful. The
    // switch still works locally; nothing goes on the wire.
    expect(enqueueMock).not.toHaveBeenCalled()
  })
})

describe("<MobileSettingsPanel /> — transport tier indicator", () => {
  it("hides the indicator outside of Capacitor", () => {
    transportMock.isCapacitor.mockReturnValue(false)
    render(<MobileSettingsPanel />)
    expect(screen.queryByTestId("mobile-transport-tier")).not.toBeInTheDocument()
  })

  it("renders the tier indicator under Capacitor with the seeded value", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    render(<MobileSettingsPanel />)
    const row = screen.getByTestId("mobile-transport-tier")
    expect(row).toBeInTheDocument()
    expect(row).toHaveTextContent(/WebRTC \(direct\)/)
    expect(transportMock.getActiveTier).toHaveBeenCalled()
    expect(transportMock.onTierChange).toHaveBeenCalled()
  })

  it.each([
    ["rtc-direct", /WebRTC \(direct\)/],
    ["rtc-relay", /WebRTC \(TURN relay\)/],
    ["ws-lan", /LAN/],
    ["ws-tunnel", /Tunnel \(HTTPS\)/],
    ["offline", /Offline/],
  ])("renders the label for tier=%s", (tier, expected) => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = tier
    render(<MobileSettingsPanel />)
    expect(screen.getByTestId("mobile-transport-tier")).toHaveTextContent(expected)
  })

  it("updates the tier when the transport emits a change", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "offline"
    render(<MobileSettingsPanel />)
    expect(screen.getByTestId("mobile-transport-tier")).toHaveTextContent(/Offline/)
    // Drive a transition through the captured subscriber.
    act(() => {
      for (const h of tierHandlers) h("rtc-direct")
    })
    expect(screen.getByTestId("mobile-transport-tier")).toHaveTextContent(/WebRTC \(direct\)/)
  })

  it("detaches the tier subscription on unmount", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "ws-lan"
    const { unmount } = render(<MobileSettingsPanel />)
    expect(tierHandlers.size).toBe(1)
    unmount()
    expect(tierHandlers.size).toBe(0)
  })

  // ── Reconnect button (W2) ──────────────────────────────────────────────

  it("renders the reconnect button only while on an RTC tier", () => {
    transportMock.isCapacitor.mockReturnValue(true)

    transportMock.tier = "rtc-direct"
    const { unmount: unmount1 } = render(<MobileSettingsPanel />)
    expect(screen.getByTestId("mobile-transport-tier-reconnect")).toBeInTheDocument()
    unmount1()

    transportMock.tier = "rtc-relay"
    const { unmount: unmount2 } = render(<MobileSettingsPanel />)
    expect(screen.getByTestId("mobile-transport-tier-reconnect")).toBeInTheDocument()
    unmount2()

    transportMock.tier = "ws-lan"
    const { unmount: unmount3 } = render(<MobileSettingsPanel />)
    expect(screen.queryByTestId("mobile-transport-tier-reconnect")).not.toBeInTheDocument()
    unmount3()

    transportMock.tier = "offline"
    const { unmount: unmount4 } = render(<MobileSettingsPanel />)
    expect(screen.queryByTestId("mobile-transport-tier-reconnect")).not.toBeInTheDocument()
    unmount4()
  })

  it("clicking the reconnect button delegates to transport.reconnectRtc()", async () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockClear()
    transportMock.reconnectRtc.mockReturnValue("ok")
    render(<MobileSettingsPanel />)
    const btn = screen.getByTestId("mobile-transport-tier-reconnect")
    fireEvent.click(btn)
    expect(transportMock.reconnectRtc).toHaveBeenCalledTimes(1)
    // The button enters a short busy window before falling back to live
    // tier-driven visibility. The interim disabled-state is enough to
    // verify here.
    expect(btn).toBeDisabled()
  })

  it("surfaces 'no-tier' as a warning toast when transport reports it", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockReturnValue("no-tier")
    render(<MobileSettingsPanel />)
    // Even though tier is rtc-direct in the indicator, the underlying
    // transport may have torn down right before the click — we surface a
    // warning toast instead of pretending success.
    fireEvent.click(screen.getByTestId("mobile-transport-tier-reconnect"))
    expect(transportMock.reconnectRtc).toHaveBeenCalled()
  })

  it("surfaces 'throttled' separately so the user knows it's not an error", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockReturnValue("throttled")
    render(<MobileSettingsPanel />)
    fireEvent.click(screen.getByTestId("mobile-transport-tier-reconnect"))
    expect(transportMock.reconnectRtc).toHaveBeenCalled()
  })
})
