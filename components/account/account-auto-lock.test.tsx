/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { AccountAutoLock } from "./account-auto-lock"

const useAutoLockOnIdleMock = jest.fn()
jest.mock("@/hooks/account/use-auto-lock-on-idle", () => ({
  useAutoLockOnIdle: () => useAutoLockOnIdleMock(),
}))

describe("AccountAutoLock", () => {
  it("mounts the idle auto-lock hook and renders nothing", () => {
    const { container } = render(<AccountAutoLock />)

    expect(useAutoLockOnIdleMock).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
  })
})
