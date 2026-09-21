/** @jest-environment jsdom */
import { render } from "@testing-library/react"

import { ImNotifyInitializer } from "./im-notify-initializer"

const installImNotifyWatcher = jest.fn()
jest.mock("@/stores/chat/im-notify-store", () => ({
  installImNotifyWatcher: (...a: unknown[]) => installImNotifyWatcher(...a),
}))

describe("ImNotifyInitializer", () => {
  beforeEach(() => {
    installImNotifyWatcher.mockReset().mockReturnValue(jest.fn())
  })

  it("installs the watcher with localized strings and renders nothing", () => {
    const { container } = render(<ImNotifyInitializer />)
    expect(installImNotifyWatcher).toHaveBeenCalledTimes(1)
    const strings = installImNotifyWatcher.mock.calls[0][0]
    expect(strings.done("My chat")).toBe("My chat finished")
    expect(strings.error("My chat")).toBe("My chat ran into an error")
    expect(strings.attention("My chat")).toBe("My chat needs your input")
    expect(container).toBeEmptyDOMElement()
  })

  it("uninstalls on unmount", () => {
    const un = jest.fn()
    installImNotifyWatcher.mockReturnValue(un)
    const { unmount } = render(<ImNotifyInitializer />)
    unmount()
    expect(un).toHaveBeenCalledTimes(1)
  })
})
