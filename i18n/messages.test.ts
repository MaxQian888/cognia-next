import { defaultMessages, startupMessages, loadMessages } from "./messages"
import enMessages from "./messages/en.json"
import { defaultLocale } from "./config"

describe("i18n message loaders", () => {
  it("exposes only the startup subset as defaultMessages", () => {
    expect(defaultMessages).toBe(startupMessages.en)
    expect(defaultMessages).not.toBe(enMessages)
  })

  it("loadMessages resolves the lazy default catalog", async () => {
    await expect(loadMessages(defaultLocale)).resolves.toBe(enMessages)
    await expect(loadMessages("en")).resolves.toBe(enMessages)
  })

  it("loadMessages('zh-CN') loads the code-split locale chunk with the same namespaces", async () => {
    const zh = await loadMessages("zh-CN")
    expect(zh).toBeTruthy()
    expect(zh).not.toBe(enMessages)
    // key parity: every en namespace exists in the lazily-loaded zh-CN bundle
    expect(Object.keys(zh)).toEqual(expect.arrayContaining(Object.keys(enMessages)))
    expect(zh.artifacts.downloadAsWord).toBe("下载为 Word")
    expect(zh.artifacts.downloadAsPdf).toBe("下载为 PDF")
  })

  it("falls back to the default loader for an unknown locale", async () => {
    // @ts-expect-error exercising the defensive fallback with an invalid locale
    await expect(loadMessages("fr")).resolves.toBe(enMessages)
  })

  it("provides labels for every plugin scheduled-job filter", async () => {
    const zh = await loadMessages("zh-CN")
    const expected = {
      all: "All",
      active: "Active",
      paused: "Paused",
      disabled: "Disabled",
      expired: "Expired",
    }

    expect(enMessages.plugins.scheduledJobs.status).toMatchObject(expected)
    expect(zh.plugins.scheduledJobs.status).toEqual(
      expect.objectContaining({
        all: expect.any(String),
        active: expect.any(String),
        paused: expect.any(String),
        disabled: expect.any(String),
        expired: expect.any(String),
      })
    )
  })
})

it.each(["en", "zh-CN"] as const)(
  "keeps the %s startup catalog small and consistent with full translations",
  async (locale) => {
    const full = await loadMessages(locale)
    const startup = startupMessages[locale]
    expect(full).toMatchObject(startup)
    for (const namespace of [
      "account",
      "common",
      "loading",
      "diagnostics",
      "exitDialog",
      "whiteScreenRecovery",
      "mobile",
    ]) {
      expect(startup).toHaveProperty(namespace)
    }
    expect(startup).not.toHaveProperty("settings")
    expect(startup).not.toHaveProperty("chat")
    expect(JSON.stringify(startup).length).toBeLessThan(JSON.stringify(full).length / 10)
  }
)
