/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { McpLogProvider } from "./mcp-log-provider"

const subscribeMock = jest.fn()
jest.mock("@/lib/mcp/log-bridge", () => ({
  subscribeToMcpLogs: () => subscribeMock(),
}))

beforeEach(() => {
  subscribeMock.mockReset()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe("<McpLogProvider />", () => {
  it("subscribes on Tauri and unsubscribes on unmount", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    const unlisten = jest.fn()
    subscribeMock.mockResolvedValueOnce(unlisten)

    const { unmount } = render(
      <McpLogProvider>
        <div>child</div>
      </McpLogProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    unmount()
    expect(unlisten).toHaveBeenCalled()
  })

  it("does nothing on web", async () => {
    render(
      <McpLogProvider>
        <div>child</div>
      </McpLogProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it("unsubscribes even when subscribe resolves after unmount", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    let resolveSub: (fn: () => void) => void = () => {}
    subscribeMock.mockReturnValueOnce(
      new Promise<() => void>((r) => {
        resolveSub = r
      })
    )
    const unlisten = jest.fn()

    const { unmount } = render(
      <McpLogProvider>
        <div>child</div>
      </McpLogProvider>
    )

    unmount()
    resolveSub(unlisten)
    await new Promise((r) => setTimeout(r, 0))
    expect(unlisten).toHaveBeenCalled()
  })

  it("swallows a subscribe failure without throwing", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    subscribeMock.mockRejectedValueOnce(new Error("no ipc"))

    render(
      <McpLogProvider>
        <div>child</div>
      </McpLogProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
