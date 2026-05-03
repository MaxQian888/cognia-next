/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"

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
  storeState.settings = { fontScale: "md", language: "en", reduceMotion: false }
})

describe("TypographyTab", () => {
  it("renders all three controls", () => {
    render(<TypographyTab />)
    expect(screen.getByText("fontScaleLabel")).toBeInTheDocument()
    expect(screen.getByText("languageLabel")).toBeInTheDocument()
    expect(screen.getByText("reduceMotionLabel")).toBeInTheDocument()
  })

  it("toggles reduce-motion via the switch", () => {
    render(<TypographyTab />)
    fireEvent.click(screen.getByLabelText("reduceMotionLabel"))
    expect(save).toHaveBeenCalledWith({ reduceMotion: true })
  })
})
