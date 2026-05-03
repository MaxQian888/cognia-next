/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, params?: { count?: number }) =>
    params?.count != null ? `${k}:${params.count}` : k,
}))

const setCustomCss = jest.fn()
const setCustomCssEnabled = jest.fn()
const storeState: { customCss: string; customCssEnabled: boolean } = {
  customCss: "",
  customCssEnabled: false,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      customCss: storeState.customCss,
      customCssEnabled: storeState.customCssEnabled,
      setCustomCss,
      setCustomCssEnabled,
    })
  ),
}))

import { AdvancedTab } from "./advanced-tab"

beforeEach(() => {
  jest.clearAllMocks()
  storeState.customCss = ""
  storeState.customCssEnabled = false
})

describe("AdvancedTab", () => {
  it("toggles enabled via setCustomCssEnabled", () => {
    render(<AdvancedTab />)
    fireEvent.click(screen.getByLabelText("enabledLabel"))
    expect(setCustomCssEnabled).toHaveBeenCalledWith(true)
  })

  it("saves the textarea content", async () => {
    render(<AdvancedTab />)
    const ta = screen.getByLabelText("title")
    fireEvent.change(ta, { target: { value: "body { color: red; }" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /saveButton/ }))
    })
    expect(setCustomCss).toHaveBeenCalledWith("body { color: red; }")
  })

  it("strips remote @import on save and surfaces the count", async () => {
    render(<AdvancedTab />)
    const ta = screen.getByLabelText("title")
    fireEvent.change(ta, {
      target: { value: '@import url("https://evil.com/x.css"); body { color: red; }' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /saveButton/ }))
    })
    expect(setCustomCss).toHaveBeenCalled()
    const savedArg = setCustomCss.mock.calls[0][0] as string
    expect(savedArg).not.toContain("@import")
    expect(screen.getByText(/removed:1/)).toBeInTheDocument()
  })

  it("syncs draft when the persisted css changes", () => {
    storeState.customCss = "a { color: blue }"
    const { rerender } = render(<AdvancedTab />)
    const ta = screen.getByLabelText("title") as HTMLTextAreaElement
    expect(ta.value).toBe("a { color: blue }")
    storeState.customCss = "a { color: green }"
    rerender(<AdvancedTab />)
    expect(ta.value).toBe("a { color: green }")
  })
})
