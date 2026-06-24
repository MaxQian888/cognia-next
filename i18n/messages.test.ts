import { defaultMessages, loadMessages } from "./messages"
import enMessages from "./messages/en.json"
import { defaultLocale } from "./config"

describe("i18n message loaders", () => {
  it("exposes the eager default-locale bundle as defaultMessages", () => {
    expect(defaultMessages).toBe(enMessages)
  })

  it("loadMessages resolves the default locale to the already-bundled object", async () => {
    await expect(loadMessages(defaultLocale)).resolves.toBe(enMessages)
    await expect(loadMessages("en")).resolves.toBe(enMessages)
  })

  it("loadMessages('zh-CN') loads the code-split locale chunk with the same namespaces", async () => {
    const zh = await loadMessages("zh-CN")
    expect(zh).toBeTruthy()
    expect(zh).not.toBe(enMessages)
    // key parity: every en namespace exists in the lazily-loaded zh-CN bundle
    expect(Object.keys(zh)).toEqual(expect.arrayContaining(Object.keys(enMessages)))
  })

  it("falls back to the default loader for an unknown locale", async () => {
    // @ts-expect-error exercising the defensive fallback with an invalid locale
    await expect(loadMessages("fr")).resolves.toBe(enMessages)
  })
})
