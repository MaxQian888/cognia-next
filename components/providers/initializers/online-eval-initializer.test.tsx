import { render } from "@testing-library/react"

const startOnlineEvalScheduler = jest.fn()
jest.mock("@/lib/ai/eval/online/scheduler", () => ({
  startOnlineEvalScheduler: (...args: unknown[]) => startOnlineEvalScheduler(...args),
}))

import { OnlineEvalInitializer } from "./online-eval-initializer"

describe("OnlineEvalInitializer", () => {
  beforeEach(() => {
    startOnlineEvalScheduler.mockReset()
    startOnlineEvalScheduler.mockResolvedValue(jest.fn())
  })

  it("starts the drain loop once on mount", async () => {
    render(<OnlineEvalInitializer />)
    await Promise.resolve()
    expect(startOnlineEvalScheduler).toHaveBeenCalledTimes(1)
  })

  it("does not start a second loop across re-renders", async () => {
    const view = render(<OnlineEvalInitializer />)
    view.rerender(<OnlineEvalInitializer />)
    await Promise.resolve()
    expect(startOnlineEvalScheduler).toHaveBeenCalledTimes(1)
  })

  it("stops the loop on unmount", async () => {
    const unsubscribe = jest.fn()
    startOnlineEvalScheduler.mockResolvedValue(unsubscribe)
    const view = render(<OnlineEvalInitializer />)
    await Promise.resolve()
    await Promise.resolve()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("renders nothing", () => {
    const { container } = render(<OnlineEvalInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
