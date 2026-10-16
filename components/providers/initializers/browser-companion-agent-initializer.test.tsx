/** @jest-environment jsdom */
import { render } from "@testing-library/react"

const startRuntime = jest.fn()
let tauri = true

jest.mock("@/lib/browser-companion/host-dispatch", () => ({
  startBrowserCompanionAgentRuntime: (...args: unknown[]) => startRuntime(...args),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

import { BrowserCompanionAgentInitializer } from "./browser-companion-agent-initializer"

describe("BrowserCompanionAgentInitializer", () => {
  beforeEach(() => {
    startRuntime.mockReset()
    tauri = true
  })

  it("starts the runtime on the desktop and tears it down on unmount", async () => {
    const teardown = jest.fn()
    startRuntime.mockResolvedValue(teardown)
    const { unmount } = render(<BrowserCompanionAgentInitializer />)
    await Promise.resolve()
    await Promise.resolve()
    expect(startRuntime).toHaveBeenCalledTimes(1)
    unmount()
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it("tears down a runtime that finished starting after unmount", async () => {
    const teardown = jest.fn()
    let resolve: (value: () => void) => void = () => undefined
    startRuntime.mockReturnValue(new Promise((done) => (resolve = done)))
    const { unmount } = render(<BrowserCompanionAgentInitializer />)
    unmount()
    resolve(teardown)
    await Promise.resolve()
    await Promise.resolve()
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it("does nothing outside the desktop shell", () => {
    tauri = false
    render(<BrowserCompanionAgentInitializer />)
    expect(startRuntime).not.toHaveBeenCalled()
  })
})
