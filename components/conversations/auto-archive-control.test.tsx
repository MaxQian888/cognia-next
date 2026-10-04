/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>): string =>
      values ? `${key}:${JSON.stringify(values)}` : key,
}))

let settingsValue: Partial<AppSettings> | null = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: settingsValue }),
}))

const patch = jest.fn(async () => undefined)
jest.mock("@/hooks/use-settings-patch", () => ({ useSettingsPatch: () => patch }))

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target: null, vaultState: "unlocked", connectionState: "online" }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({ hostOwnsSessionState: jest.fn(() => false) }))

import { hostOwnsSessionState } from "@/lib/db/mobile-outbound-queue"
import { AUTO_ARCHIVE_AFTER_DAYS_OPTIONS } from "@/lib/chat/auto-archive"

import { AutoArchiveControl } from "./auto-archive-control"

const hostOwned = jest.mocked(hostOwnsSessionState)

beforeEach(() => {
  settingsValue = null
  patch.mockClear()
  hostOwned.mockReturnValue(false)
})

test("shows Off when no policy is stored, without writing anything", () => {
  render(<AutoArchiveControl />)
  const select = screen.getByRole("combobox", { name: "selectLabel" })
  expect(select).toHaveTextContent("options.off")
  expect(select).toBeEnabled()
  expect(patch).not.toHaveBeenCalled()
})

test("says which conversations are never auto-archived and that archives can be restored", () => {
  render(<AutoArchiveControl />)
  const select = screen.getByRole("combobox", { name: "selectLabel" })
  expect(select).toHaveAccessibleDescription("description")
  expect(screen.getByText("label")).toBeInTheDocument()
})

test("offers Off and every allowed day count", async () => {
  const user = userEvent.setup()
  render(<AutoArchiveControl />)
  await user.click(screen.getByRole("combobox", { name: "selectLabel" }))
  const options = screen.getAllByRole("option").map((option) => option.textContent)
  expect(options).toEqual([
    "options.off",
    ...AUTO_ARCHIVE_AFTER_DAYS_OPTIONS.map((count) => `options.days:${JSON.stringify({ count })}`),
  ])
})

test("persists a chosen day count, keeping the rest of the archive settings", async () => {
  settingsValue = { conversationArchive: { autoArchiveAfterDays: null } }
  const user = userEvent.setup()
  render(<AutoArchiveControl />)
  await user.click(screen.getByRole("combobox", { name: "selectLabel" }))
  await user.click(
    screen.getByRole("option", { name: `options.days:${JSON.stringify({ count: 30 })}` })
  )
  expect(patch).toHaveBeenCalledWith({ conversationArchive: { autoArchiveAfterDays: 30 } })
})

test("turns the policy off", async () => {
  settingsValue = { conversationArchive: { autoArchiveAfterDays: 14 } }
  const user = userEvent.setup()
  render(<AutoArchiveControl />)
  const select = screen.getByRole("combobox", { name: "selectLabel" })
  expect(select).toHaveTextContent(`options.days:${JSON.stringify({ count: 14 })}`)
  await user.click(select)
  await user.click(screen.getByRole("option", { name: "options.off" }))
  expect(patch).toHaveBeenCalledWith({ conversationArchive: { autoArchiveAfterDays: null } })
})

test("reads a stored value outside the allowed list as Off", () => {
  settingsValue = { conversationArchive: { autoArchiveAfterDays: 3 } }
  render(<AutoArchiveControl />)
  expect(screen.getByRole("combobox", { name: "selectLabel" })).toHaveTextContent("options.off")
})

test("is disabled on a paired client, where the Host decides", () => {
  hostOwned.mockReturnValue(true)
  settingsValue = { conversationArchive: { autoArchiveAfterDays: 30 } }
  render(<AutoArchiveControl />)
  const select = screen.getByRole("combobox", { name: "selectLabel" })
  expect(select).toBeDisabled()
  // A local value governs nothing here, so none is shown as if it did.
  expect(select).toHaveTextContent("hostPlaceholder")
  expect(screen.getByTestId("auto-archive-host-note")).toHaveTextContent("hostDecides")
  expect(select).toHaveAccessibleDescription("description hostDecides")
  expect(hostOwned).toHaveBeenCalledWith(
    expect.objectContaining({ target: null, connectionState: "online" })
  )
})

test("renders a compact inline variant for a toolbar", async () => {
  const user = userEvent.setup()
  render(<AutoArchiveControl variant="inline" />)
  const control = screen.getByTestId("auto-archive-control")
  expect(control).toHaveAttribute("data-variant", "inline")
  const select = within(control).getByRole("combobox", { name: "selectLabel" })
  expect(select).toHaveAttribute("data-size", "sm")
  // The explanation is kept for assistive tech without taking toolbar room.
  expect(select).toHaveAccessibleDescription("description")
  await user.click(select)
  await user.click(
    screen.getByRole("option", { name: `options.days:${JSON.stringify({ count: 90 })}` })
  )
  expect(patch).toHaveBeenCalledWith({ conversationArchive: { autoArchiveAfterDays: 90 } })
})

test("renders the inline host note when the Host decides", () => {
  hostOwned.mockReturnValue(true)
  render(<AutoArchiveControl variant="inline" />)
  expect(screen.getByRole("combobox", { name: "selectLabel" })).toBeDisabled()
  expect(screen.getByTestId("auto-archive-host-note")).toHaveTextContent("hostDecides")
})

test("defaults to the card variant", () => {
  render(<AutoArchiveControl />)
  expect(screen.getByTestId("auto-archive-control")).toHaveAttribute("data-variant", "card")
})
