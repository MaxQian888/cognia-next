import { KNOWN_CHAT_APPS, resolveChatApp } from "./chat-apps"

describe("resolveChatApp", () => {
  it("recognizes two-sided apps by bundle id or process name", () => {
    expect(resolveChatApp({ appName: "微信", bundleId: "com.tencent.xinWeChat" })).toEqual({
      id: "wechat",
      layout: "two_sided",
    })
    expect(resolveChatApp({ appName: "WeChat.exe" })).toEqual({
      id: "wechat",
      layout: "two_sided",
    })
    expect(resolveChatApp({ appName: "  Telegram  ", bundleId: null })).toEqual({
      id: "telegram",
      layout: "two_sided",
    })
  })

  it("marks single-column apps so their sides are never guessed", () => {
    expect(resolveChatApp({ appName: "Slack", bundleId: "com.tinyspeck.slackmacgap" }).layout).toBe(
      "single_column"
    )
    expect(resolveChatApp({ appName: "Discord.exe" }).layout).toBe("single_column")
  })

  it("leaves an unlisted app to inference", () => {
    expect(resolveChatApp({ appName: "Feishu", bundleId: "com.bytedance.macos.feishu" })).toEqual({
      id: null,
      layout: "unknown",
    })
  })

  it("keeps every table entry lowercase and unique", () => {
    const ids = KNOWN_CHAT_APPS.map((app) => app.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const app of KNOWN_CHAT_APPS) {
      for (const name of app.names) expect(name).toBe(name.toLowerCase())
    }
  })
})
