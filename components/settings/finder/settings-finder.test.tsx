/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const replaceMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams("section=general"),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// One control with keywords, one without — exercises the optional-keywords path.
jest.mock("./control-registry", () => ({
  SETTING_CONTROLS: [
    { id: "default-model", sectionId: "general", labelKey: "defaultModel", keywords: ["model"] },
    { id: "no-keywords", sectionId: "about", labelKey: "autoUpdate" },
  ],
}))

import { SettingsFinder } from "./settings-finder"

beforeEach(() => {
  replaceMock.mockClear()
})

describe("SettingsFinder", () => {
  it("lists control and section entries when open", () => {
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    expect(screen.getAllByTestId("finder-control").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("finder-section").length).toBeGreaterThan(0)
  })

  it("navigates to section + focus when a control is chosen", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<SettingsFinder open onOpenChange={onOpenChange} />)
    await user.click(screen.getAllByTestId("finder-control")[0])
    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
    const url = replaceMock.mock.calls[0][0] as string
    expect(url).toContain("section=")
    expect(url).toContain("focus=")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("navigates to a bare section (no focus) when a section is chosen", async () => {
    const user = userEvent.setup()
    render(<SettingsFinder open onOpenChange={jest.fn()} />)
    await user.click(screen.getAllByTestId("finder-section")[0])
    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
    const url = replaceMock.mock.calls[0][0] as string
    expect(url).toContain("section=")
    expect(url).not.toContain("focus=")
  })
})
