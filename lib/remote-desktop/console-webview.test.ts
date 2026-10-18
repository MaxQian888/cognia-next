jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))

import {
  __setConsoleWebviewCallerForTests,
  closeConsoleWebview,
  openConsoleWebview,
  reloadConsoleWebview,
  setConsoleWebviewBounds,
  setConsoleWebviewVisible,
} from "./console-webview"

const rect = { x: 10, y: 20, width: 800, height: 600 }

afterEach(() => __setConsoleWebviewCallerForTests())

describe("remote console webview", () => {
  it("runs placement calls in order, even when an earlier one is slow or fails", async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const call = jest.fn((name: string) => {
      order.push(`start:${name}`)
      if (name === "remote_console_open") {
        return new Promise<void>((resolve) => {
          release = () => {
            order.push(`end:${name}`)
            resolve()
          }
        })
      }
      if (name === "remote_console_reload") return Promise.reject(new Error("gone"))
      order.push(`end:${name}`)
      return Promise.resolve()
    })
    __setConsoleWebviewCallerForTests({ call } as never)
    const opened = openConsoleWebview("https://gw.lan/#/client/x", rect)
    const moved = setConsoleWebviewBounds({ ...rect, x: 30 })
    const reloaded = reloadConsoleWebview()
    const hidden = setConsoleWebviewVisible(false, rect)
    const closed = closeConsoleWebview()
    await Promise.resolve()
    expect(order).toEqual(["start:remote_console_open"])
    release()
    await opened
    await moved
    await expect(reloaded).rejects.toThrow("gone")
    await hidden
    await closed
    expect(order).toEqual([
      "start:remote_console_open",
      "end:remote_console_open",
      "start:remote_console_set_bounds",
      "end:remote_console_set_bounds",
      "start:remote_console_reload",
      "start:remote_console_set_visible",
      "end:remote_console_set_visible",
      "start:remote_console_close",
      "end:remote_console_close",
    ])
    expect(call).toHaveBeenCalledWith("remote_console_open", {
      url: "https://gw.lan/#/client/x",
      ...rect,
    })
    expect(call).toHaveBeenCalledWith("remote_console_set_visible", { visible: false, ...rect })
  })

  it("never asks the native side to open a link with a login in it", async () => {
    const call = jest.fn()
    __setConsoleWebviewCallerForTests({ call } as never)
    await expect(
      openConsoleWebview("https://mesh.lan/?gotonode=n&logintoken=x", rect)
    ).rejects.toMatchObject({ code: "remote_desktop_console_url_invalid" })
    expect(call).not.toHaveBeenCalled()
  })
})
