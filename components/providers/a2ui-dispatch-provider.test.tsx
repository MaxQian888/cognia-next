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

  // Regression: Tauri's async unlisten rejects with `listeners[eventId].handlerId`
  // when a StrictMode remount unsubscribes before the registration eval lands.
  // Calling it raw floated the rejection out of the effect as an unhandled
  // rejection; it must be swallowed on both teardown paths.
  it("does not surface an unhandled rejection when the unlisten rejects on unmount", async () => {
    const onUnhandled = jest.fn()
    process.on("unhandledRejection", onUnhandled)
    try {
      const unlisten = jest.fn(() => Promise.reject(new TypeError("listeners[eventId].handlerId")))
      mSubscribe.mockResolvedValueOnce(unlisten)

      const { unmount } = render(
        <A2UIDispatchProvider>
          <span>child</span>
        </A2UIDispatchProvider>
      )

      await waitFor(() => expect(mSubscribe).toHaveBeenCalledTimes(1))
      expect(() => unmount()).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unlisten).toHaveBeenCalledTimes(1)
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("does not surface an unhandled rejection when the post-unmount unlisten rejects", async () => {
    const onUnhandled = jest.fn()
    process.on("unhandledRejection", onUnhandled)
    try {
      let resolveSubscribe: (fn: () => Promise<void>) => void = () => {}
      const subscribePromise = new Promise<() => Promise<void>>((resolve) => {
        resolveSubscribe = resolve
      })
      mSubscribe.mockReturnValueOnce(subscribePromise)

      const { unmount } = render(
        <A2UIDispatchProvider>
          <span>child</span>
        </A2UIDispatchProvider>
      )

      unmount()

      const unlisten = jest.fn(() => Promise.reject(new TypeError("listeners[eventId].handlerId")))
      resolveSubscribe(unlisten)
      await subscribePromise
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unlisten).toHaveBeenCalledTimes(1)
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
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
