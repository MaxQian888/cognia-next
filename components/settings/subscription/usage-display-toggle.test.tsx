/**
 * @jest-environment jsdom
 */

import { fireEvent, render } from "@testing-library/react"

import { UsageDisplayToggle } from "./usage-display-toggle"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const setMode = jest.fn()
let currentMode = "standard"
jest.mock("@/hooks/usage/use-usage-display-mode", () => ({
  useUsageDisplayMode: () => ({ mode: currentMode, setMode }),
}))

beforeEach(() => {
  setMode.mockClear()
  currentMode = "standard"
})

describe("UsageDisplayToggle", () => {
  it("renders the three mode items", () => {
    const { getByTestId } = render(<UsageDisplayToggle />)
    expect(getByTestId("usage-display-simplified")).toBeTruthy()
    expect(getByTestId("usage-display-standard")).toBeTruthy()
    expect(getByTestId("usage-display-detailed")).toBeTruthy()
  })

  it("calls setMode when a different mode is selected", () => {
    const { getByTestId } = render(<UsageDisplayToggle />)
    fireEvent.click(getByTestId("usage-display-detailed"))
    expect(setMode).toHaveBeenCalledWith("detailed")
  })

  it("ignores deselecting the active item (empty value)", () => {
    currentMode = "standard"
    const { getByTestId } = render(<UsageDisplayToggle />)
    fireEvent.click(getByTestId("usage-display-standard"))
    expect(setMode).not.toHaveBeenCalled()
  })
})
