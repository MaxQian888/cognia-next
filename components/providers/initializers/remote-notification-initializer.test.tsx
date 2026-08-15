import { render } from "@testing-library/react"

const dispose = jest.fn()
const install = jest.fn(() => dispose)
jest.mock("@/lib/notifications/remote-subscription", () => ({
  installRemoteNotificationListener: () => install(),
}))

import { RemoteNotificationInitializer } from "./remote-notification-initializer"

describe("RemoteNotificationInitializer", () => {
  it("installs the remote-notification listener on mount and disposes it on unmount", () => {
    const { unmount, container } = render(<RemoteNotificationInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(install).toHaveBeenCalledTimes(1)
    unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
