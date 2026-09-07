import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const profileRef = { value: "desktop" as string }
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => profileRef.value }))

const availableRef = { value: true }
jest.mock("@/lib/power/screen-wake-lock", () => ({
  isScreenHoldAvailable: () => availableRef.value,
}))

import { SessionPowerPicker } from "./session-power-picker"

function renderPicker(props: Partial<React.ComponentProps<typeof SessionPowerPicker>> = {}) {
  const onValueChange = jest.fn()
  render(
    <SessionPowerPicker
      value="inherit"
      onValueChange={onValueChange}
      appDefault="allowScreenOff"
      idPrefix="test"
      {...props}
    />
  )
  return { onValueChange }
}

beforeEach(() => {
  profileRef.value = "desktop"
  availableRef.value = true
})

describe("SessionPowerPicker", () => {
  it("offers inherit only where inheriting is possible", () => {
    renderPicker({ includeInherit: true })
    expect(screen.getByTestId("session-power-option-inherit")).toBeInTheDocument()
  })

  it("hides inherit for the app-wide default, which has nothing above it", () => {
    renderPicker({ value: "allowScreenOff" })
    expect(screen.queryByTestId("session-power-option-inherit")).not.toBeInTheDocument()
    expect(screen.getByTestId("session-power-option-keepScreenOn")).toBeInTheDocument()
  })

  it("spells out what following the default currently means", () => {
    renderPicker({ includeInherit: true, appDefault: "keepScreenOn" })
    expect(
      screen.getByText(/Use the app default \(Keep the screen on while running\)/)
    ).toBeInTheDocument()
  })

  it("reports the effect of the RESOLVED mode, not the literal value", () => {
    // `inherit` is not an effect. A user who inherits "keep the screen on"
    // must read the screen-held line, not the let-it-sleep one.
    renderPicker({ includeInherit: true, value: "inherit", appDefault: "keepScreenOn" })
    expect(screen.getByTestId("session-power-effect")).toHaveTextContent(/screen stays on/i)
  })

  it("warns a standalone browser tab that its turn can be suspended", () => {
    profileRef.value = "web-standalone"
    renderPicker({ value: "allowScreenOff" })
    expect(screen.getByTestId("session-power-effect")).toHaveTextContent(/may pause it/i)
  })

  it("admits when this runtime cannot hold the screen at all", () => {
    availableRef.value = false
    renderPicker({ value: "keepScreenOn" })
    expect(screen.getByTestId("session-power-effect")).toHaveTextContent(/cannot hold the screen/i)
    // Still selectable: the choice must survive to a device that can honour it.
    expect(screen.getByTestId("session-power-option-keepScreenOn")).toHaveAttribute(
      "data-selected",
      "true"
    )
  })

  it("reports the chosen policy back to the caller", async () => {
    const { onValueChange } = renderPicker({ includeInherit: true })
    await userEvent.click(screen.getByTestId("session-power-option-keepScreenOn"))
    expect(onValueChange).toHaveBeenCalledWith("keepScreenOn")
  })
})
