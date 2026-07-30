/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

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

// Native range stand-in for the Slider.
jest.mock("@/components/ui/slider", () => {
  const React = jest.requireActual("react")
  return {
    Slider: ({ value, onValueChange, min, max, step, ...rest }: Record<string, unknown>) =>
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
    await Promise.resolve()
    await Promise.resolve()
    const prefs = lastPrefs()
    expect(prefs?.globalDefaultChannels).toEqual(expect.arrayContaining(["center", "toast", "os"]))
    // Host mirroring moved into the persistence funnel
    // (`lib/settings/mirror-to-host.ts`), which also covers the mobile routes
    // that embed a desktop settings section. A second enqueue here would send
    // every edit twice.
    expect(enqueueMock).not.toHaveBeenCalled()
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

  it("moving the retention sliders persists numeric limits", async () => {
    settingsRef.current = { notificationPreferences: { quietHours: { enabled: false } } }
    render(<NotificationPreferencesSection />)
    fireEvent.change(screen.getByTestId("notification-retention-items"), {
      target: { value: "1000" },
    })
    await Promise.resolve()
    expect(lastPrefs()).toEqual(expect.objectContaining({ retentionMaxItems: 1000 }))
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
