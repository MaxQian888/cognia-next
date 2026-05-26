/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DiscoverHelp } from "./discover-help"

const openBrowserMock = jest.fn()
jest.mock("@/lib/capacitor/browser", () => ({
  open: (opts: { url: string }) => openBrowserMock(opts),
}))

const openAppSettingsMock = jest.fn()
jest.mock("@/lib/capacitor/app-settings", () => ({
  openAppSettings: () => openAppSettingsMock(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "help.trigger": "Can't find your desktop?",
      "help.tipSameNetwork": "Same Wi-Fi network",
      "help.tipFirewall": "Firewall allows it",
      "help.tipEnableServer": "Companion server is on",
      "help.docsCta": "Read the guide",
      "help.openSettings": "Open Settings",
    }
    return map[key] ?? key
  },
}))

describe("<DiscoverHelp />", () => {
  it("is collapsed by default and expands when emphasised", () => {
    const { rerender } = render(<DiscoverHelp />)
    expect(screen.queryByText("Same Wi-Fi network")).not.toBeInTheDocument()
    rerender(<DiscoverHelp emphasised />)
    expect(screen.getByText("Same Wi-Fi network")).toBeInTheDocument()
  })

  it("toggles open on trigger click and lists all tips", async () => {
    const user = userEvent.setup()
    render(<DiscoverHelp />)
    await user.click(screen.getByTestId("pair-discover-help-trigger"))
    expect(screen.getByText("Same Wi-Fi network")).toBeInTheDocument()
    expect(screen.getByText("Firewall allows it")).toBeInTheDocument()
    expect(screen.getByText("Companion server is on")).toBeInTheDocument()
  })

  it("opens the docs in the in-app browser", async () => {
    const user = userEvent.setup()
    render(<DiscoverHelp emphasised />)
    await user.click(screen.getByTestId("pair-discover-help-docs"))
    expect(openBrowserMock).toHaveBeenCalledWith({ url: "https://docs.cognia.app/docs/en/getting-started" })
  })

  it("deep-links to the OS settings", async () => {
    const user = userEvent.setup()
    render(<DiscoverHelp emphasised />)
    await user.click(screen.getByTestId("pair-discover-help-settings"))
    expect(openAppSettingsMock).toHaveBeenCalled()
  })
})
