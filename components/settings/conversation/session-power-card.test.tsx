/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AppSettings } from "@cognia/agent-config-types"

let settingsValue: Partial<AppSettings> | null = null
const save = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: unknown }) => T): T =>
    selector({ settings: settingsValue, save }),
}))

jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => "desktop" }))
jest.mock("@/lib/power/screen-wake-lock", () => ({ isScreenHoldAvailable: () => true }))

import { SessionPowerCard } from "./session-power-card"

beforeEach(() => {
  settingsValue = null
  save.mockReset()
})

test("shows the shipped default without writing it back", () => {
  render(<SessionPowerCard />)
  expect(screen.getByTestId("session-power-option-allowScreenOff")).toHaveAttribute(
    "data-selected",
    "true"
  )
  // Persisting a value the user never chose would turn a default into a
  // decision, and the next default change would not reach them.
  expect(save).not.toHaveBeenCalled()
})

test("offers no inherit row: the app default has nothing above it", () => {
  render(<SessionPowerCard />)
  expect(screen.queryByTestId("session-power-option-inherit")).not.toBeInTheDocument()
})

test("persists a chosen default", async () => {
  render(<SessionPowerCard />)
  await userEvent.click(screen.getByTestId("session-power-option-keepScreenOn"))
  expect(save).toHaveBeenCalledWith({ sessionPowerPolicy: "keepScreenOn" })
})

test("reflects a stored default", () => {
  settingsValue = { sessionPowerPolicy: "keepScreenOn" }
  render(<SessionPowerCard />)
  expect(screen.getByTestId("session-power-option-keepScreenOn")).toHaveAttribute(
    "data-selected",
    "true"
  )
})

test("is rendered by the Conversation settings section", () => {
  // A settings card nobody mounts is invisible, and nothing else in the app
  // would notice.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const source = require("fs").readFileSync(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("path").join(
      process.cwd(),
      "components/settings/conversation/conversation-section.tsx"
    ),
    "utf8"
  ) as string
  expect(source).toContain("<SessionPowerCard />")
})
