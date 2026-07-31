/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
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

import { TypographyTab } from "./typography-tab"

beforeEach(() => {
  save.mockClear()
  storeState.settings = { fontScale: "md", language: "en" }
})

describe("TypographyTab", () => {
  it("renders type controls only: font scale, language, families, fine-tuning", () => {
    render(<TypographyTab />)
    expect(screen.getByText("fontScaleLabel")).toBeInTheDocument()
    expect(screen.getByText("languageLabel")).toBeInTheDocument()
    expect(screen.getByText("font.sectionLabel")).toBeInTheDocument()
    expect(screen.getByText("fine.sectionLabel")).toBeInTheDocument()
  })

  it("no longer hosts motion / reduce-motion / density (moved to other tabs)", () => {
    render(<TypographyTab />)
    expect(screen.queryByText("reduceMotionLabel")).not.toBeInTheDocument()
    expect(screen.queryByText("motion.sectionLabel")).not.toBeInTheDocument()
    expect(screen.queryByText("density.sectionLabel")).not.toBeInTheDocument()
  })

  it("restores the default line-height via the slider-row reset", () => {
    storeState.settings = {
      fontScale: "md",
      language: "en",
      typographyExt: { lineHeightScale: 1.2, letterSpacingEm: 0 },
    }
    render(<TypographyTab />)
    // Only line-height drifted from default → exactly one reset control shows.
    fireEvent.click(screen.getByLabelText("resetToDefault"))
    expect(save).toHaveBeenCalled()
    const patch = save.mock.calls[0][0] as { typographyExt: { lineHeightScale: number } }
    expect(patch.typographyExt.lineHeightScale).toBe(1)
  })
})
