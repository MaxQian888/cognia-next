/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { RunStatusBarSettings } from "@/lib/claude/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let settingsValue: RunStatusBarSettings | null = null
const save = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: unknown }) => T): T =>
    selector({ settings: settingsValue ? { runStatusBar: settingsValue } : null, save }),
}))

import { RunStatusBarCard } from "./run-status-bar-card"

beforeEach(() => {
  settingsValue = null
  save.mockReset()
})

test("groups the six metric toggles under one card", () => {
  render(<RunStatusBarCard />)
  expect(screen.getByLabelText("elapsed.label")).toBeInTheDocument()
  expect(screen.getByLabelText("outputTokens.label")).toBeInTheDocument()
  expect(screen.getByLabelText("speed.label")).toBeInTheDocument()
  expect(screen.getByLabelText("cost.label")).toBeInTheDocument()
  expect(screen.getByLabelText("contextPct.label")).toBeInTheDocument()
  expect(screen.getByLabelText("tools.label")).toBeInTheDocument()
})

test("defaults: elapsed/tokens/speed/tools on, cost/context off", () => {
  render(<RunStatusBarCard />)
  expect(screen.getByLabelText("elapsed.label")).toBeChecked()
  expect(screen.getByLabelText("outputTokens.label")).toBeChecked()
  expect(screen.getByLabelText("speed.label")).toBeChecked()
  expect(screen.getByLabelText("tools.label")).toBeChecked()
  expect(screen.getByLabelText("cost.label")).not.toBeChecked()
  expect(screen.getByLabelText("contextPct.label")).not.toBeChecked()
})

test("enabling cost saves runStatusBar.showCost=true", async () => {
  const user = userEvent.setup()
  render(<RunStatusBarCard />)
  await user.click(screen.getByLabelText("cost.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showCost: true } })
})

test("toggling an on-by-default metric off persists the explicit false", async () => {
  const user = userEvent.setup()
  render(<RunStatusBarCard />)
  await user.click(screen.getByLabelText("speed.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showSpeed: false } })
})

test("merges the patch over existing persisted settings", async () => {
  settingsValue = { showContextPct: true }
  const user = userEvent.setup()
  render(<RunStatusBarCard />)
  await user.click(screen.getByLabelText("cost.label"))
  expect(save).toHaveBeenCalledWith({
    runStatusBar: { showContextPct: true, showCost: true },
  })
})

test("every toggle persists its matching field", async () => {
  const user = userEvent.setup()
  render(<RunStatusBarCard />)
  await user.click(screen.getByLabelText("elapsed.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showElapsed: false } })
  await user.click(screen.getByLabelText("outputTokens.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showOutputTokens: false } })
  await user.click(screen.getByLabelText("speed.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showSpeed: false } })
  await user.click(screen.getByLabelText("cost.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showCost: true } })
  await user.click(screen.getByLabelText("contextPct.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showContextPct: true } })
  await user.click(screen.getByLabelText("tools.label"))
  expect(save).toHaveBeenCalledWith({ runStatusBar: { showTools: false } })
})

test("reflects a persisted config", () => {
  settingsValue = { showSpeed: false, showContextPct: true }
  render(<RunStatusBarCard />)
  expect(screen.getByLabelText("speed.label")).not.toBeChecked()
  expect(screen.getByLabelText("contextPct.label")).toBeChecked()
})
