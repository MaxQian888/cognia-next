/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const install = jest.fn()
const dispose = jest.fn()
jest.mock("@/lib/agent/plan/notify", () => ({
  installPlanNotificationActions: () => {
    install()
    return dispose
  },
}))

import { PlanNotificationInitializer } from "./plan-notification-initializer"

beforeEach(() => jest.clearAllMocks())

describe("PlanNotificationInitializer", () => {
  it("installs the plan notification command handler once", () => {
    const { rerender } = render(<PlanNotificationInitializer />)
    rerender(<PlanNotificationInitializer />)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("unregisters on unmount so a remount cannot double-register", () => {
    const { unmount } = render(<PlanNotificationInitializer />)
    unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    const { container } = render(<PlanNotificationInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
