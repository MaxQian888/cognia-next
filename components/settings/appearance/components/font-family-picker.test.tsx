/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import {
  __resetFontRegistryForTesting,
  registerPluginFont,
  setSystemFonts,
} from "@/lib/appearance/font-registry"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { FontFamilyPicker } from "./font-family-picker"

beforeEach(() => {
  __resetFontRegistryForTesting()
})

describe("FontFamilyPicker", () => {
  it("renders the inherit option and the web-safe families", () => {
    const onChange = jest.fn()
    render(<FontFamilyPicker labelKey="font.sansLabel" value={undefined} onChange={onChange} />)
    // Open the select. Trigger + dropdown both surface the selected label,
    // hence using getAllByText.
    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getAllByText("font.inherit").length).toBeGreaterThan(0)
    expect(screen.getAllByText("monospace").length).toBeGreaterThan(0)
  })

  it("clicking a system entry fires onChange with the family name", () => {
    setSystemFonts(["Inter"])
    const onChange = jest.fn()
    render(<FontFamilyPicker labelKey="font.sansLabel" value={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByText("Inter"))
    expect(onChange).toHaveBeenCalledWith("Inter")
  })

  it("includes plugin-registered fonts marked with the plugin source", () => {
    registerPluginFont("pluginA", "Cascadia Code")
    render(<FontFamilyPicker labelKey="font.sansLabel" value={undefined} onChange={jest.fn()} />)
    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getByText("Cascadia Code")).toBeInTheDocument()
    expect(screen.getAllByText(/plugin/).length).toBeGreaterThan(0)
  })

  it("inherit option calls onChange with undefined", () => {
    const onChange = jest.fn()
    render(<FontFamilyPicker labelKey="font.sansLabel" value="Inter" onChange={onChange} />)
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByText("font.inherit"))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("monoOnly filter trims sans-only web-safe entries", () => {
    render(
      <FontFamilyPicker labelKey="font.monoLabel" value={undefined} onChange={jest.fn()} monoOnly />
    )
    fireEvent.click(screen.getByRole("combobox"))
    // monospace stays (matches "mono" keyword), but "sans-serif" should NOT.
    expect(screen.getByText("monospace")).toBeInTheDocument()
    expect(screen.queryByText("sans-serif")).toBeNull()
  })

  it("monoOnly keeps system fonts by their monospaced flag, not the name", () => {
    // A proportional family whose name lacks any mono keyword must be hidden,
    // and a monospace family whose name also lacks one must be kept — proving
    // the real flag drives the filter, not the heuristic.
    setSystemFonts([
      { family: "Helvetica Neue", monospaced: false },
      { family: "Iosevka Term", monospaced: true },
    ])
    render(
      <FontFamilyPicker labelKey="font.monoLabel" value={undefined} onChange={jest.fn()} monoOnly />
    )
    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getByText("Iosevka Term")).toBeInTheDocument()
    expect(screen.queryByText("Helvetica Neue")).toBeNull()
  })
})
