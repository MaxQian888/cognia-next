import { render, screen, within } from "@testing-library/react"
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
