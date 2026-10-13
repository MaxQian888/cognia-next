import { isAppHandoffAvailable, openInApp, type AppHandoffLoader } from "./app-handoff"

function loaderWith(plugin: { isAvailable?: jest.Mock; open?: jest.Mock }): AppHandoffLoader {
  return async () => ({
    isAvailable: plugin.isAvailable ?? jest.fn(),
    open: plugin.open ?? jest.fn(),
  })
}

describe("isAppHandoffAvailable", () => {
  it("reports the native answer for the target", async () => {
    const isAvailable = jest.fn(async () => ({ available: true }))
    await expect(isAppHandoffAvailable("feishu", loaderWith({ isAvailable }))).resolves.toBe(true)
    expect(isAvailable).toHaveBeenCalledWith({ target: "feishu" })
  })

  it("is false when the app is missing, the plugin is absent or the answer is malformed", async () => {
    await expect(
      isAppHandoffAvailable(
        "feishu",
        loaderWith({ isAvailable: jest.fn(async () => ({ available: false })) })
      )
    ).resolves.toBe(false)
    await expect(
      isAppHandoffAvailable("feishu", async () => {
        throw new Error("CogniaAppHandoff is unavailable")
      })
    ).resolves.toBe(false)
    await expect(
      isAppHandoffAvailable("feishu", loaderWith({ isAvailable: jest.fn(async () => "yes") }))
    ).resolves.toBe(false)
  })

  it("gives up after the probe timeout instead of holding the sign-in", async () => {
    jest.useFakeTimers()
    try {
      const pending = isAppHandoffAvailable(
        "feishu",
        loaderWith({ isAvailable: jest.fn(() => new Promise(() => {})) })
      )
      await jest.advanceTimersByTimeAsync(2_000)
      await expect(pending).resolves.toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("openInApp", () => {
  it("passes the target and link, and reports whether the app took it", async () => {
    const open = jest.fn(async () => ({ opened: true }))
    await expect(
      openInApp("feishu", "https://applink.feishu.cn/x", loaderWith({ open }))
    ).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith({ target: "feishu", url: "https://applink.feishu.cn/x" })
  })

  it("is false when the app refused, the call threw or the plugin is absent", async () => {
    await expect(
      openInApp("feishu", "u", loaderWith({ open: jest.fn(async () => ({ opened: false })) }))
    ).resolves.toBe(false)
    await expect(
      openInApp(
        "feishu",
        "u",
        loaderWith({ open: jest.fn(async () => Promise.reject(new Error("bad url"))) })
      )
    ).resolves.toBe(false)
    await expect(
      openInApp("feishu", "u", async () => {
        throw new Error("missing")
      })
    ).resolves.toBe(false)
  })
})
