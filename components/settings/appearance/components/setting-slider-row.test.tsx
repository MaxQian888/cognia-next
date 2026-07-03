/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { SettingSliderRow } from "./setting-slider-row"

const base = {
  label: "Radius",
  value: 0.625,
  defaultValue: 0.625,
  min: 0,
  max: 1.5,
  step: 0.025,
}

describe("SettingSliderRow", () => {
  it("renders the formatted read-out and a default marker", () => {
    render(<SettingSliderRow {...base} onChange={() => {}} format={(v) => `${v}rem`} />)
    expect(screen.getByText("0.625rem")).toBeInTheDocument()
    expect(screen.getByTestId("default-marker")).toBeInTheDocument()
  })

  it("hides the reset control while the value equals the default", () => {
    render(<SettingSliderRow {...base} onChange={() => {}} />)
    expect(screen.queryByLabelText("resetToDefault")).not.toBeInTheDocument()
  })

  it("reveals the reset control when modified and restores the default on click", () => {
    const onChange = jest.fn()
    render(<SettingSliderRow {...base} value={1.2} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText("resetToDefault"))
    expect(onChange).toHaveBeenCalledWith(0.625)
  })

  it("clamps the default marker within the track", () => {
    render(<SettingSliderRow {...base} defaultValue={5} onChange={() => {}} />)
    expect(screen.getByTestId("default-marker")).toHaveStyle({ left: "100%" })
  })

  it("renders a slider control", () => {
    render(<SettingSliderRow {...base} ariaLabel="Corner radius" onChange={() => {}} />)
    expect(screen.getByRole("slider")).toBeInTheDocument()
  })
})
