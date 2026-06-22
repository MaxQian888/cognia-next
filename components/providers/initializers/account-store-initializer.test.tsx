/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { StrictMode } from "react"

const mockLoad = jest.fn(async () => undefined)
const mockWarn = jest.fn()

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ load: mockLoad }) },
}))

jest.mock("@/lib/logging", () => ({
  loggers: { shell: { warn: mockWarn } },
}))

let AccountStoreInitializer: typeof import("./account-store-initializer").AccountStoreInitializer

beforeAll(async () => {
  AccountStoreInitializer = (await import("./account-store-initializer")).AccountStoreInitializer
})

beforeEach(() => {
  mockLoad.mockClear()
  mockWarn.mockClear()
})

describe("AccountStoreInitializer", () => {
  it("calls the account store load() once on mount", () => {
    render(<AccountStoreInitializer />)
    expect(mockLoad).toHaveBeenCalledTimes(1)
  })

  it("does not re-run load() on re-render", () => {
    const { rerender } = render(<AccountStoreInitializer />)
    rerender(<AccountStoreInitializer />)
    expect(mockLoad).toHaveBeenCalledTimes(1)
  })

  it("ignores React StrictMode's duplicate effect pass", () => {
    render(
      <StrictMode>
        <AccountStoreInitializer />
      </StrictMode>
    )
    expect(mockLoad).toHaveBeenCalledTimes(1)
  })

  it("logs boot load failures without rendering UI", async () => {
    mockLoad.mockRejectedValueOnce(new Error("load failed"))
    const { container } = render(<AccountStoreInitializer />)
    await Promise.resolve()
    expect(mockWarn).toHaveBeenCalledWith("account-store: boot load threw", {
      err: expect.any(Error),
    })
    expect(container).toBeEmptyDOMElement()
  })
})
