import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NotificationPreferences } from "@/types/notifications"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const save = jest.fn()
let settings: { notificationPreferences?: Partial<NotificationPreferences> } = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings, save }),
}))

const permission = { state: "default", requesting: false, request: jest.fn() }
jest.mock("@/hooks/notifications/use-notification-permission", () => ({
  useNotificationPermission: () => permission,
}))

// The delivery panel owns its own Dexie-backed test; here it's a stub so the
// section's preference-form assertions stay focused on AppSettings.
jest.mock("./notification-delivery-panel", () => ({
  NotificationDeliveryPanel: () => <div data-testid="delivery-panel-stub" />,
}))

// Range input standing in for the Radix slider: `change` is one drag frame
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
        value: (value as number[])[0],
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

import { NotificationsSection } from "./notifications-section"

beforeEach(() => {
  jest.clearAllMocks()
  settings = {}
  permission.state = "default"
  permission.requesting = false
})

it("renders the section heading", () => {
  render(<NotificationsSection />)
  expect(screen.getByTestId("notifications-settings")).toBeInTheDocument()
  expect(screen.getByText("settings.notifications.title")).toBeInTheDocument()
})

it("toggling a default channel saves the merged preference (center stays)", async () => {
  render(<NotificationsSection />)
  // Default channels are center+toast; toggle OS on.
  const osRow = screen.getByText("settings.notifications.channel.os").closest("div")!
  await userEvent.click(within(osRow).getByRole("switch"))
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      notificationPreferences: expect.objectContaining({
        globalDefaultChannels: expect.arrayContaining(["center", "os"]),
      }),
    })
  )
})

it("muting a source records a per-source override", async () => {
  render(<NotificationsSection />)
  const row = screen.getByText("notificationCenter.sources.plugin").closest("label")!
  await userEvent.click(within(row).getByRole("switch"))
  const arg = save.mock.calls[0][0].notificationPreferences as NotificationPreferences
  expect(arg.perSource.plugin?.enabled).toBe(false)
})

it("enabling quiet hours reveals the time inputs", async () => {
  settings = {
    notificationPreferences: { quietHours: { enabled: true, start: "22:00", end: "08:00" } },
  }
  render(<NotificationsSection />)
  expect(screen.getByLabelText("settings.notifications.dndStart")).toHaveValue("22:00")
  await userEvent.clear(screen.getByLabelText("settings.notifications.dndEnd"))
})

it("saves a quiet-hours time once, on blur, and reverts a cleared one", async () => {
  settings = {
    notificationPreferences: { quietHours: { enabled: true, start: "22:00", end: "08:00" } },
  }
  render(<NotificationsSection />)
  const start = screen.getByLabelText("settings.notifications.dndStart")
  // Each segment edit used to be a save, and on a paired phone a queued update.
  fireEvent.change(start, { target: { value: "21:00" } })
  fireEvent.change(start, { target: { value: "23:15" } })
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.blur(start)
  })
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0][0].notificationPreferences.quietHours).toEqual(
    expect.objectContaining({ start: "23:15", end: "08:00" })
  )

  save.mockClear()
  const end = screen.getByLabelText("settings.notifications.dndEnd")
  fireEvent.change(end, { target: { value: "" } })
  await act(async () => {
    fireEvent.blur(end)
  })
  expect(save).not.toHaveBeenCalled()
  expect(end).toHaveValue("08:00")
})

it("saves each retention drag once, on release, not per frame", async () => {
  render(<NotificationsSection />)
  const days = screen.getByRole("slider", { name: "settings.notifications.retentionDaysLabel" })
  fireEvent.change(days, { target: { value: "10" } })
  fireEvent.change(days, { target: { value: "45" } })
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.pointerUp(days)
  })
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0][0].notificationPreferences.retentionMaxAgeMs).toBe(
    45 * 24 * 60 * 60 * 1000
  )

  save.mockClear()
  const items = screen.getByRole("slider", { name: "settings.notifications.retentionItemsLabel" })
  fireEvent.change(items, { target: { value: "300" } })
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.pointerUp(items)
  })
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0][0].notificationPreferences.retentionMaxItems).toBe(300)
})

it("a behaviour switch (focus-aware) persists", async () => {
  render(<NotificationsSection />)
  const row = screen
    .getByText("settings.notifications.focusAwareLabel")
    .closest("div")!.parentElement!
  await userEvent.click(within(row).getByRole("switch"))
  expect(save).toHaveBeenCalled()
})

it("requesting OS permission calls the hook", async () => {
  render(<NotificationsSection />)
  await userEvent.click(
    screen.getByRole("button", { name: "settings.notifications.osPermissionEnable" })
  )
  expect(permission.request).toHaveBeenCalled()
})

it("shows enabled state when permission is granted", () => {
  permission.state = "granted"
  render(<NotificationsSection />)
  expect(screen.getByText("settings.notifications.osPermissionGranted")).toBeInTheDocument()
})

it("reset restores the default preferences", async () => {
  render(<NotificationsSection />)
  await userEvent.click(screen.getByRole("button", { name: /resetDefaults/ }))
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      notificationPreferences: expect.objectContaining({
        globalDefaultChannels: ["center", "toast"],
      }),
    })
  )
})
