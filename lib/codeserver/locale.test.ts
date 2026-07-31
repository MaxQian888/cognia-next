import { readRuntimeArgsLocale, vscodeLocaleForAppLanguage, withRuntimeArgsLocale } from "./locale"

describe("vscodeLocaleForAppLanguage", () => {
  it("maps the app's language tags onto VS Code's spelling", () => {
    expect(vscodeLocaleForAppLanguage("en")).toBe("en")
    // VS Code uses lowercase hyphenated tags; the app uses BCP-47 casing.
    expect(vscodeLocaleForAppLanguage("zh-CN")).toBe("zh-cn")
  })

  it("defaults to English when the app language has not hydrated", () => {
    expect(vscodeLocaleForAppLanguage(undefined)).toBe("en")
  })

  it("lowercases an unmapped tag rather than dropping it", () => {
    // A language added to the app later still gets a plausible locale; the Rust
    // side refuses to guess a pack id for one it doesn't know, so the worst case
    // is an English UI rather than a failed 120s install.
    expect(vscodeLocaleForAppLanguage("pt-BR" as never)).toBe("pt-br")
  })
})

describe("readRuntimeArgsLocale", () => {
  it("reads a declared locale", () => {
    expect(readRuntimeArgsLocale('{"locale":"zh-cn"}')).toBe("zh-cn")
  })

  it("tolerates the JSONC VS Code writes into argv.json", () => {
    const raw = `
    // This configuration file allows you to pass permanent command line arguments.
    {
      // Display language
      "locale": "ja",
      "enable-crash-reporter": false
    }`
    expect(readRuntimeArgsLocale(raw)).toBe("ja")
  })

  it("returns null for an empty, blank, wrong-typed or broken document", () => {
    expect(readRuntimeArgsLocale("")).toBeNull()
    expect(readRuntimeArgsLocale("   ")).toBeNull()
    expect(readRuntimeArgsLocale("{}")).toBeNull()
    expect(readRuntimeArgsLocale('{"locale":""}')).toBeNull()
    expect(readRuntimeArgsLocale('{"locale":"  "}')).toBeNull()
    expect(readRuntimeArgsLocale('{"locale":42}')).toBeNull()
    expect(readRuntimeArgsLocale("{ not json")).toBeNull()
    expect(readRuntimeArgsLocale("[1,2]")).toBeNull()
  })
})

describe("withRuntimeArgsLocale", () => {
  it("sets the locale on an empty document", () => {
    expect(JSON.parse(withRuntimeArgsLocale("", "zh-cn"))).toEqual({ locale: "zh-cn" })
  })

  it("preserves every other runtime argument", () => {
    const raw = JSON.stringify({
      "enable-crash-reporter": false,
      "disable-hardware-acceleration": true,
      locale: "en",
    })
    const next = JSON.parse(withRuntimeArgsLocale(raw, "zh-cn"))
    expect(next).toEqual({
      "enable-crash-reporter": false,
      "disable-hardware-acceleration": true,
      locale: "zh-cn",
    })
  })

  it("preserves arguments written as JSONC", () => {
    const raw = `{
      // keep me
      "enable-crash-reporter": false
    }`
    const next = JSON.parse(withRuntimeArgsLocale(raw, "ja"))
    expect(next["enable-crash-reporter"]).toBe(false)
    expect(next.locale).toBe("ja")
  })

  it("rewrites a corrupt document rather than leaving the wrong language pinned", () => {
    expect(JSON.parse(withRuntimeArgsLocale("{ broken", "ja"))).toEqual({ locale: "ja" })
    expect(JSON.parse(withRuntimeArgsLocale("[1,2]", "ja"))).toEqual({ locale: "ja" })
  })

  it("writes readable, newline-terminated JSON", () => {
    const out = withRuntimeArgsLocale("{}", "zh-cn")
    expect(out.endsWith("\n")).toBe(true)
    expect(out).toContain('\n  "locale"')
  })
})
