/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const save = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: storeState.settings, save })
  ),
}))

import { A11yTab } from "./a11y-tab"

beforeEach(() => {
  save.mockReset()
  storeState.settings = {}
})

describe("A11yTab — defaults", () => {
  it("renders the WCAG target select and surfaces the default value", () => {
    render(<A11yTab />)
    // The default a11y.wcagTarget is "AA". We assert via the rendered label
    // (the option text mirrors the translation key "wcag.target.AA").
    expect(screen.getAllByText(/wcag\.target\.AA/i).length).toBeGreaterThan(0)
  })

  it("renders every section heading", () => {
    render(<A11yTab />)
    expect(screen.getByText("wcag.targetLabel")).toBeInTheDocument()
    expect(screen.getByText("wcag.enforcementLabel")).toBeInTheDocument()
    expect(screen.getByText("highContrast.label")).toBeInTheDocument()
    expect(screen.getByText("colorblind.label")).toBeInTheDocument()
    expect(screen.getByText("motion.speedLabel")).toBeInTheDocument()
    expect(screen.getByText("motion.reduceLabel")).toBeInTheDocument()
  })
})

describe("A11yTab — reduce motion toggle", () => {
  it("calls save with motion.reduce=true when toggled on", () => {
    render(<A11yTab />)
    const reduceLabel = screen.getByText("motion.reduceLabel")
    const switchEl = within(reduceLabel.closest("div.flex") as HTMLElement).getByRole("switch")
    fireEvent.click(switchEl)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        motion: expect.objectContaining({ reduce: true }),
      })
    )
  })
})

describe("A11yTab — preserves siblings on save", () => {
  it("a11y patch carries over the unchanged keys", () => {
    storeState.settings = {
      a11y: {
        wcagTarget: "AAA",
        enforcement: "warn",
        highContrast: "off",
        colorblindMode: "off",
      },
    }
    render(<A11yTab />)
    // Flip the reduce-motion switch — that should NOT alter the a11y slice.
    const reduceLabel = screen.getByText("motion.reduceLabel")
    const switchEl = within(reduceLabel.closest("div.flex") as HTMLElement).getByRole("switch")
    fireEvent.click(switchEl)
    // Dual-write: the canonical motion.reduce plus the legacy boolean, and
    // nothing in the a11y slice.
    expect(save.mock.calls[0][0]).toEqual({
      motion: expect.objectContaining({ reduce: true }),
      reduceMotion: true,
    })
  })
})
