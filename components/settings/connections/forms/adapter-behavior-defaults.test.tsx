import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AdapterBehaviorDefaults } from "./adapter-behavior-defaults"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const mockAdapterRow = { id: "a", defaultMode: "auto", activationTtlMs: 3_600_000 }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockAdapterRow,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const mockUpdateAdapterConfigSection = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...args: unknown[]) => mockUpdateAdapterConfigSection(...args),
}))

it("reuses the shared behavior editor in Adapter scope", () => {
  render(<AdapterBehaviorDefaults adapterId="a" />)
  expect(screen.getByTestId("conversation-behavior-editor")).toBeInTheDocument()
  expect(screen.getByTestId("behavior-ttl")).toHaveValue(1)
})

it("writes the axes a preset means, and the legacy mirror alongside", async () => {
  const user = userEvent.setup()
  render(<AdapterBehaviorDefaults adapterId="a" />)

  await user.click(screen.getByTestId("behavior-mode"))
  await user.click(screen.getByRole("option", { name: "preset_draft" }))
  await user.click(screen.getByRole("button", { name: "save" }))

  expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
    "a",
    "behavior",
    expect.objectContaining({
      // The axes are what routing reads; `defaultMode` is the mirror kept in
      // step for `InboxSendPolicy.forcedMode` and older clients.
      defaultAutonomy: "suggest",
      defaultMode: "draft",
      // `draft` leaves engagement derived, so binding a team later still works.
      defaultEngagement: undefined,
    }),
    "settings.adapter.behavior"
  )
})

it("offers delegate only where background work has a carrier", async () => {
  const user = userEvent.setup()
  render(<AdapterBehaviorDefaults adapterId="a" />)

  await user.click(screen.getByTestId("behavior-mode"))
  // A bot with no team or workflow bound cannot run anything in the
  // background, so the option says so instead of silently doing nothing.
  const delegate = screen.getByRole("option", {
    name: /preset_delegate/,
  })
  expect(delegate).toHaveAttribute("aria-disabled", "true")
})

// Tri-state at the BOT scope too — `undefined` there means "whatever this
// channel supports", not off, so the picker needs three options and not two.
it("writes the bot-wide A2UI switch and can clear it back to the channel default", async () => {
  const user = userEvent.setup()
  render(<AdapterBehaviorDefaults adapterId="a" />)

  await user.click(screen.getByTestId("behavior-a2ui"))
  await user.click(screen.getByRole("option", { name: "a2uiOff" }))
  await user.click(screen.getByRole("button", { name: "save" }))
  expect(mockUpdateAdapterConfigSection).toHaveBeenCalledWith(
    "a",
    "behavior",
    expect.objectContaining({ a2uiEnabled: false }),
    "settings.adapter.behavior"
  )

  await user.click(screen.getByTestId("behavior-a2ui"))
  await user.click(screen.getByRole("option", { name: "a2uiChannelDefault" }))
  await user.click(screen.getByRole("button", { name: "save" }))
  expect(mockUpdateAdapterConfigSection).toHaveBeenLastCalledWith(
    "a",
    "behavior",
    expect.objectContaining({ a2uiEnabled: undefined }),
    "settings.adapter.behavior"
  )
})
