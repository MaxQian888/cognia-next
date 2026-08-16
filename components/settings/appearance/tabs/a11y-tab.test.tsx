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

// Flat, the six controls were near-identical select blocks separated by
// unlabelled hairlines; nothing said which ones belonged together.
describe("A11yTab — grouping", () => {
  it.each([
    ["contrast", ["wcag.targetLabel", "wcag.enforcementLabel"]],
    ["vision", ["highContrast.label", "colorblind.label"]],
    ["motion", ["motion.speedLabel", "motion.reduceLabel"]],
  ])("puts the %s controls in one titled card", (group, labels) => {
    render(<A11yTab />)
    const card = screen.getByTestId(`a11y-group-${group}`)
    for (const label of labels) expect(within(card).getByText(label)).toBeInTheDocument()
  })

  it("titles each card", () => {
    render(<A11yTab />)
    for (const group of ["contrast", "vision", "motion"]) {
      expect(
        within(screen.getByTestId(`a11y-group-${group}`)).getByText(`${group}.label`)
      ).toBeInTheDocument()
    }
  })
})

// Reduced motion pins every duration to zero, so a speed multiplier under it
// is a control that provably does nothing.
describe("A11yTab — animation speed under reduce motion", () => {
  it("stays usable while reduce motion is off", () => {
    render(<A11yTab />)
    expect(screen.getByLabelText("motion.speedLabel")).not.toBeDisabled()
    expect(screen.queryByText("motion.speedDisabledHint")).not.toBeInTheDocument()
  })

  it("is disabled and explains why once reduce motion is on", () => {
    storeState.settings = { motion: { reduce: true, speed: 1 } }
    render(<A11yTab />)
    expect(screen.getByLabelText("motion.speedLabel")).toBeDisabled()
    expect(screen.getByText("motion.speedDisabledHint")).toBeInTheDocument()
  })

  // The desktop View menu writes the legacy boolean, not `motion.reduce`.
  it("honours the legacy reduceMotion boolean too", () => {
    storeState.settings = { reduceMotion: true }
    render(<A11yTab />)
    expect(screen.getByLabelText("motion.speedLabel")).toBeDisabled()
  })
})

// Every select writes back through the same generic row, so each one needs a
// case of its own — a shared helper that only ever fired the first would leave
// the other three writing to the wrong settings key undetected.
describe("A11yTab — select writes", () => {
  function choose(selectLabel: string, optionName: string) {
    fireEvent.click(screen.getByLabelText(selectLabel))
    fireEvent.click(screen.getByRole("option", { name: optionName }))
    return save.mock.calls[0][0]
  }

  it("writes the WCAG target", () => {
    render(<A11yTab />)
    expect(choose("wcag.targetLabel", "wcag.target.AAA")).toEqual({
      a11y: expect.objectContaining({ wcagTarget: "AAA" }),
    })
  })

  it("writes the enforcement mode", () => {
    render(<A11yTab />)
    expect(choose("wcag.enforcementLabel", "wcag.enforcement.warn")).toEqual({
      a11y: expect.objectContaining({ enforcement: "warn" }),
    })
  })

  it("writes the high-contrast preset", () => {
    render(<A11yTab />)
    expect(choose("highContrast.label", "highContrast.dark")).toEqual({
      a11y: expect.objectContaining({ highContrast: "dark" }),
    })
  })

  it("writes the colorblind palette", () => {
    render(<A11yTab />)
    expect(choose("colorblind.label", "colorblind.protan")).toEqual({
      a11y: expect.objectContaining({ colorblindMode: "protan" }),
    })
  })

  // The option values are numbers behind a string-valued Radix select.
  it("writes the animation speed as a number", () => {
    render(<A11yTab />)
    expect(choose("motion.speedLabel", "motion.speed.slow")).toEqual({
      motion: expect.objectContaining({ speed: 0.5 }),
    })
  })

  it("leaves the sibling a11y keys untouched", () => {
    storeState.settings = {
      a11y: {
        wcagTarget: "AAA",
        enforcement: "warn",
        highContrast: "light",
        colorblindMode: "deuter",
      },
    }
    render(<A11yTab />)
    expect(choose("colorblind.label", "colorblind.off")).toEqual({
      a11y: {
        wcagTarget: "AAA",
        enforcement: "warn",
        highContrast: "light",
        colorblindMode: "off",
      },
    })
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
