/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { PersonalizationPanel } from "./personalization-panel"
import { DEFAULT_LOCK_SCREEN } from "@/types/appearance/lock-screen"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const setLockScreen = jest.fn(async () => {})
const state = {
  wallpapers: [],
  lockScreen: { ...DEFAULT_LOCK_SCREEN },
  setLockScreen,
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof state) => unknown) => selector(state),
}))

jest.mock("@/lib/appearance", () => ({
  withBuiltinPresets: (list: unknown[]) => list,
}))

jest.mock("../../personalization-card", () => ({
  PersonalizationCard: () => <div data-testid="personalization-card" />,
}))

describe("PersonalizationPanel", () => {
  it("renders the existing personalization card", () => {
    render(<PersonalizationPanel />)
    expect(screen.getByTestId("personalization-card")).toBeInTheDocument()
  })

  it("renders the lock screen card, so the settings are reachable", () => {
    // The wiring this panel exists to provide. Without it the lock-screen
    // settings would be built and unreachable.
    render(<PersonalizationPanel />)
    expect(screen.getByTestId("lock-screen-card")).toBeInTheDocument()
  })
})
