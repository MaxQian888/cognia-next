/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { NOTIFICATION_SOURCES } from "@/types/notifications"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)

const settingsRef: { current: Record<string, unknown> | undefined } = { current: {} }

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

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
        if (settingsRef.current) settingsRef.current = { ...settingsRef.current, ...patch }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/notifications/device-channel-gate", () => ({
  ensureDeviceChannelReady: jest.fn(async () => ({ kind: "allowed" })),
}))
jest.mock("@/lib/capacitor/app-settings", () => ({ openAppSettings: jest.fn() }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

// Native <select> stand-in so `onValueChange` is testable.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[], meta: { label?: string; testid?: string }) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.props["aria-label"]) meta.label = child.props["aria-label"] as string
        if (child.props["data-testid"]) meta.testid = child.props["data-testid"] as string
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items, meta)
      }
    )
  }
  const Select = ({ value, onValueChange, disabled, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    const meta: { label?: string; testid?: string } = {}
    collect(children, items as unknown[], meta)
    return React.createElement(
      "select",
      {
        "aria-label": meta.label,
        "data-testid": meta.testid,
        value,
        disabled,
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

// Native range stand-in for the Slider: `change` is one drag frame
// (`onValueChange`), `pointerUp` the release (`onValueCommit`).
jest.mock("@/components/ui/slider", () => {
  const React = jest.requireActual("react")
  return {
    Slider: ({
      value,
      onValueChange,
      onValueCommit,
      min,
      max,
      step,
      ...rest
    }: Record<string, unknown>) =>
      React.createElement("input", {
        type: "range",
        role: "slider",
        "aria-label": rest["aria-label"],
        "data-testid": rest["data-testid"],
        value: Array.isArray(value) ? (value as number[])[0] : value,
        min,
        max,
        step,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: number[]) => void)([Number(e.target.value)]),
        onPointerUp: (e: { currentTarget: { value: string } }) =>
          (onValueCommit as (v: number[]) => void)([Number(e.currentTarget.value)]),
      }),
  }
})

import { NotificationPreferencesSection } from "./notification-preferences-section"

const lastPrefs = () => {
  const call = saveMock.mock.calls.at(-1)?.[0] as
    | { notificationPreferences: Record<string, unknown> }
    | undefined
  return call?.notificationPreferences
}

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  settingsRef.current = {}
})

describe("NotificationPreferencesSection", () => {
  it("renders the portable preference groups with defaults", () => {
    render(<NotificationPreferencesSection />)
    expect(screen.getByTestId("mobile-notification-preferences")).toBeInTheDocument()
    // DEFAULT globalDefaultChannels = ["center", "toast"]
    expect(screen.getByTestId("notification-channel-toast")).toBeChecked()
    expect(screen.getByTestId("notification-channel-os")).not.toBeChecked()
    expect(screen.getByTestId("notification-sound")).toBeChecked()
  })

  it("toggling a channel merges it, keeping center", async () => {
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-channel-os"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    const prefs = lastPrefs()
    expect(prefs?.globalDefaultChannels).toEqual(expect.arrayContaining(["center", "toast", "os"]))
    // Host mirroring moved into the persistence funnel
    // (`lib/settings/mirror-to-host.ts`), which also covers the mobile routes
    // that embed a desktop settings section. A second enqueue here would send
    // every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("asks the device before switching system notifications on", async () => {
    const { ensureDeviceChannelReady } = jest.requireMock(
      "@/lib/notifications/device-channel-gate"
    ) as { ensureDeviceChannelReady: jest.Mock }
    ensureDeviceChannelReady.mockClear()
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-channel-os"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(ensureDeviceChannelReady).toHaveBeenCalledWith("os")
  })

  it("leaves a refused channel off and points at the app settings", async () => {
    const { ensureDeviceChannelReady } = jest.requireMock(
      "@/lib/notifications/device-channel-gate"
    ) as { ensureDeviceChannelReady: jest.Mock }
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    const { openAppSettings } = jest.requireMock("@/lib/capacitor/app-settings") as {
      openAppSettings: jest.Mock
    }
    toast.error.mockClear()
    ensureDeviceChannelReady.mockResolvedValueOnce({ kind: "denied" })
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-channel-os"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "channelDenied",
        expect.objectContaining({ action: expect.objectContaining({ label: "openSettings" }) })
      )
    )
    expect(saveMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("notification-channel-os")).not.toBeChecked()
    ;(toast.error.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick()
    expect(openAppSettings).toHaveBeenCalled()
  })

  it("says push is unavailable on a device that cannot register for it", async () => {
    const { ensureDeviceChannelReady } = jest.requireMock(
      "@/lib/notifications/device-channel-gate"
    ) as { ensureDeviceChannelReady: jest.Mock }
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    toast.error.mockClear()
    let resolveGate: (v: unknown) => void = () => undefined
    ensureDeviceChannelReady.mockImplementationOnce(
      () => new Promise((resolve) => (resolveGate = resolve))
    )
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-channel-push"))
    // Held while the registration is in flight.
    await waitFor(() => expect(screen.getByTestId("notification-channel-push")).toBeDisabled())
    await act(async () => resolveGate({ kind: "unavailable", reason: "no GMS" }))
    expect(toast.error).toHaveBeenCalledWith("pushUnavailable")
    expect(saveMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("notification-channel-push")).not.toBeDisabled()
  })

  it("switches a channel off without asking the device", async () => {
    const { ensureDeviceChannelReady } = jest.requireMock(
      "@/lib/notifications/device-channel-gate"
    ) as { ensureDeviceChannelReady: jest.Mock }
    ensureDeviceChannelReady.mockClear()
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-channel-toast"))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(ensureDeviceChannelReady).not.toHaveBeenCalled()
    expect(lastPrefs()?.globalDefaultChannels).not.toContain("toast")
  })

  it("changing the minimum OS level persists minOsLevel", async () => {
    render(<NotificationPreferencesSection />)
    fireEvent.change(screen.getByTestId("notification-min-os-level"), {
      target: { value: "error" },
    })
    await Promise.resolve()
    expect(lastPrefs()).toEqual(expect.objectContaining({ minOsLevel: "error" }))
  })

  it("toggling sound off persists sound:false", async () => {
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-sound"))
    await Promise.resolve()
    expect(lastPrefs()).toEqual(expect.objectContaining({ sound: false }))
  })

  it("muting a source writes a per-source override", async () => {
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-source-scheduler"))
    await Promise.resolve()
    expect((lastPrefs()?.perSource as Record<string, { enabled: boolean }>).scheduler).toEqual({
      enabled: false,
    })
  })

  it("revealing and editing quiet-hours times", async () => {
    render(<NotificationPreferencesSection />)
    expect(screen.queryByTestId("notification-quiet-hours-start")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("notification-quiet-hours"))
    await Promise.resolve()
    expect(lastPrefs()).toEqual(
      expect.objectContaining({ quietHours: expect.objectContaining({ enabled: true }) })
    )
  })

  it("saves a quiet-hours time once, on blur, not per change", async () => {
    settingsRef.current = {
      notificationPreferences: { quietHours: { enabled: true, start: "22:00", end: "07:00" } },
    }
    render(<NotificationPreferencesSection />)
    const start = screen.getByTestId("notification-quiet-hours-start")
    // A time field reports every segment edit; each was a queued desktop update.
    fireEvent.change(start, { target: { value: "21:00" } })
    fireEvent.change(start, { target: { value: "23:30" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.blur(start)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(lastPrefs()).toEqual(
      expect.objectContaining({
        quietHours: expect.objectContaining({ start: "23:30", end: "07:00" }),
      })
    )
  })

  it("reverts a cleared quiet-hours time instead of saving it", async () => {
    settingsRef.current = {
      notificationPreferences: { quietHours: { enabled: true, start: "22:00", end: "07:00" } },
    }
    render(<NotificationPreferencesSection />)
    const end = screen.getByTestId("notification-quiet-hours-end")
    fireEvent.change(end, { target: { value: "" } })
    await act(async () => {
      fireEvent.keyDown(end, { key: "Enter" })
    })
    expect(saveMock).not.toHaveBeenCalled()
    expect(end).toHaveValue("07:00")
  })

  it("says the day window also bounds delivery history", () => {
    settingsRef.current = { notificationPreferences: { quietHours: { enabled: false } } }
    render(<NotificationPreferencesSection />)
    expect(screen.getByText("retentionDaysHelp")).toBeInTheDocument()
  })

  it("saves each retention drag once, on release, not per frame", async () => {
    settingsRef.current = { notificationPreferences: { quietHours: { enabled: false } } }
    render(<NotificationPreferencesSection />)
    const items = screen.getByTestId("notification-retention-items")
    fireEvent.change(items, { target: { value: "550" } })
    fireEvent.change(items, { target: { value: "1000" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.pointerUp(items)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(lastPrefs()).toEqual(expect.objectContaining({ retentionMaxItems: 1000 }))

    saveMock.mockClear()
    const days = screen.getByTestId("notification-retention-days")
    fireEvent.change(days, { target: { value: "10" } })
    fireEvent.change(days, { target: { value: "14" } })
    expect(saveMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.pointerUp(days)
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(lastPrefs()).toEqual(
      expect.objectContaining({ retentionMaxAgeMs: 14 * 24 * 60 * 60 * 1000 })
    )
  })

  it("reset restores the default preferences", async () => {
    render(<NotificationPreferencesSection />)
    fireEvent.click(screen.getByTestId("notification-reset-defaults"))
    await Promise.resolve()
    expect(lastPrefs()).toEqual(
      expect.objectContaining({ globalDefaultChannels: ["center", "toast"], sound: true })
    )
  })
})

describe("notification source labels", () => {
  // The source list grew "issue" and "site" while this map did not, and the
  // phone printed `mobile.notifications.preferences.source.issue` as a label.
  it.each([
    ["en", enMessages],
    ["zh-CN", zhMessages],
  ])("labels every source in %s", (_locale, messages) => {
    const labels = messages.mobile.notifications.preferences.source as Record<string, string>
    for (const source of NOTIFICATION_SOURCES) {
      expect(labels[source]).toEqual(expect.any(String))
    }
  })
})
