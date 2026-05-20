/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { QuietHoursAndMute, type QuietHoursValue } from "./quiet-hours-and-mute"

function setup(
  opts: {
    quietHours?: QuietHoursValue | null
    muted?: boolean
  } = {}
) {
  const onMutedChange = jest.fn()
  const onQuietHoursChange = jest.fn()
  render(
    <QuietHoursAndMute
      muted={opts.muted ?? false}
      onMutedChange={onMutedChange}
      quietHours={opts.quietHours ?? null}
      onQuietHoursChange={onQuietHoursChange}
    />
  )
  return { onMutedChange, onQuietHoursChange }
}

describe("QuietHoursAndMute — base", () => {
  it("renders muted + enable switches by default", () => {
    setup()
    expect(screen.getByRole("switch", { name: /mute adapter/i })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: /enable quiet hours/i })).toBeInTheDocument()
  })

  it("does not render the from/to/tz fields when quietHours is null", () => {
    setup()
    expect(screen.queryByTestId("qhm-tz-select")).not.toBeInTheDocument()
  })

  it("toggling the enable switch seeds a default 22:00–08:00 UTC value", () => {
    const { onQuietHoursChange } = setup()
    fireEvent.click(screen.getByRole("switch", { name: /enable quiet hours/i }))
    expect(onQuietHoursChange).toHaveBeenCalledWith({ from: "22:00", to: "08:00", tz: "UTC" })
  })
})

describe("QuietHoursAndMute — timezone selector", () => {
  it("renders the common-zone dropdown when tz is a known value", () => {
    setup({
      quietHours: { from: "09:00", to: "17:00", tz: "America/New_York" },
    })
    const select = screen.getByTestId("qhm-tz-select") as HTMLSelectElement
    expect(select).toBeInTheDocument()
    expect(select.value).toBe("America/New_York")
    expect(screen.queryByTestId("qhm-tz-custom-input")).not.toBeInTheDocument()
  })

  it("starts in custom mode when persisted tz is not in COMMON_TZ", () => {
    setup({
      quietHours: { from: "09:00", to: "17:00", tz: "Asia/Singapore" },
    })
    expect(screen.queryByTestId("qhm-tz-select")).not.toBeInTheDocument()
    const input = screen.getByTestId("qhm-tz-custom-input") as HTMLInputElement
    expect(input.value).toBe("Asia/Singapore")
  })

  it("selecting 'Custom…' from the dropdown switches into a freeform input", () => {
    setup({
      quietHours: { from: "09:00", to: "17:00", tz: "UTC" },
    })
    const select = screen.getByTestId("qhm-tz-select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "__custom__" } })
    expect(screen.getByTestId("qhm-tz-custom-input")).toBeInTheDocument()
  })

  it("emits the new tz when the user types a valid IANA zone in custom mode", () => {
    const { onQuietHoursChange } = setup({
      quietHours: { from: "09:00", to: "17:00", tz: "Asia/Singapore" },
    })
    const input = screen.getByTestId("qhm-tz-custom-input")
    fireEvent.change(input, { target: { value: "Asia/Hong_Kong" } })
    expect(onQuietHoursChange).toHaveBeenLastCalledWith({
      from: "09:00",
      to: "17:00",
      tz: "Asia/Hong_Kong",
    })
  })

  it("shows an inline validation hint when the custom tz is not a real IANA id", () => {
    setup({
      quietHours: { from: "09:00", to: "17:00", tz: "Not/A_Real_Zone" },
    })
    expect(screen.getByTestId("qhm-tz-invalid")).toBeInTheDocument()
  })

  it("does not show the validation hint when the tz is empty", () => {
    setup({
      quietHours: { from: "09:00", to: "17:00", tz: "" },
    })
    expect(screen.queryByTestId("qhm-tz-invalid")).not.toBeInTheDocument()
  })
})

describe("QuietHoursAndMute — responsive layout", () => {
  it("renders the from/to/tz fields in a grid that collapses on narrow screens", () => {
    const { container } = render(
      <QuietHoursAndMute
        muted={false}
        onMutedChange={jest.fn()}
        quietHours={{ from: "09:00", to: "17:00", tz: "UTC" }}
        onQuietHoursChange={jest.fn()}
      />
    )
    const grid = container.querySelector(".grid-cols-1")
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain("sm:grid-cols-3")
  })
})
