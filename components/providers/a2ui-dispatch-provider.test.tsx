import { render, waitFor } from "@testing-library/react"

jest.mock("@/lib/a2ui/ipc", () => ({
  subscribeA2UIDispatch: jest.fn(),
}))

import { subscribeA2UIDispatch } from "@/lib/a2ui/ipc"
import { A2UIDispatchProvider } from "./a2ui-dispatch-provider"

const mSubscribe = subscribeA2UIDispatch as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("A2UIDispatchProvider", () => {
  it("subscribes once on mount and renders children", async () => {
    const unlisten = jest.fn()
    mSubscribe.mockResolvedValueOnce(unlisten)

    const { getByText } = render(
      <A2UIDispatchProvider>
        <span>child</span>
      </A2UIDispatchProvider>
    )

    expect(getByText("child")).toBeInTheDocument()
    await waitFor(() => expect(mSubscribe).toHaveBeenCalledTimes(1))
    expect(unlisten).not.toHaveBeenCalled()
  })

  it("calls the unlisten function on unmount", async () => {
    const unlisten = jest.fn()
    mSubscribe.mockResolvedValueOnce(unlisten)

    const { unmount } = render(
      <A2UIDispatchProvider>
        <span>child</span>
      </A2UIDispatchProvider>
    )

    await waitFor(() => expect(mSubscribe).toHaveBeenCalledTimes(1))
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("invokes unlisten immediately when the subscribe promise resolves after unmount", async () => {
    let resolveSubscribe: (fn: () => void) => void = () => {}
    const subscribePromise = new Promise<() => void>((resolve) => {
      resolveSubscribe = resolve
    })
    mSubscribe.mockReturnValueOnce(subscribePromise)

    const { unmount } = render(
      <A2UIDispatchProvider>
        <span>child</span>
      </A2UIDispatchProvider>
    )

    unmount()

    const unlisten = jest.fn()
    resolveSubscribe(unlisten)
    await subscribePromise
    // microtask flush
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
