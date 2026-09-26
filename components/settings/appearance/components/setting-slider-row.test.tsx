/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

// A range input standing in for the Radix slider, so a drag and its release are
// separate events: `change` is one drag frame (`onValueChange`), `pointerUp` is
// the release (`onValueCommit`) carrying the thumb's current value.
jest.mock("@/components/ui/slider", () => {
  const React = jest.requireActual("react")
  return {
    Slider: ({
      value,
      onValueChange,
      onValueCommit,
      min,
      max,
      step,
      ...rest
    }: Record<string, unknown>) =>
      React.createElement("input", {
        type: "range",
        role: "slider",
        "aria-label": rest["aria-label"],
        value: (value as number[])[0],
        min,
        max,
        step,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: number[]) => void)([Number(e.target.value)]),
        onPointerUp: (e: { currentTarget: { value: string } }) =>
          (onValueCommit as (v: number[]) => void)([Number(e.currentTarget.value)]),
      }),
  }
})

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

  it("reveals the reset control when modified and restores the default on click", async () => {
    const onChange = jest.fn()
    render(<SettingSliderRow {...base} value={1.2} onChange={onChange} />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("resetToDefault"))
    })
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

  it("persists a drag once, on release, not per frame", async () => {
    const onChange = jest.fn(async (_value: number) => undefined)
    render(<SettingSliderRow {...base} onChange={onChange} format={(v) => `${v}rem`} />)
    const slider = screen.getByRole("slider")

    // Each drag frame used to be its own settings save, and on a paired phone
    // its own queued desktop update.
    fireEvent.change(slider, { target: { value: "0.7" } })
    fireEvent.change(slider, { target: { value: "0.8" } })
    fireEvent.change(slider, { target: { value: "0.9" } })
    expect(onChange).not.toHaveBeenCalled()
    // The read-out and the reset control follow the drag before it is saved.
    expect(screen.getByText("0.9rem")).toBeInTheDocument()
    expect(screen.getByLabelText("resetToDefault")).toBeInTheDocument()

    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(0.9)
  })

  it("does not persist a drag released where it started", async () => {
    const onChange = jest.fn()
    render(<SettingSliderRow {...base} onChange={onChange} />)
    const slider = screen.getByRole("slider")
    fireEvent.change(slider, { target: { value: "1" } })
    fireEvent.change(slider, { target: { value: "0.625" } })
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
