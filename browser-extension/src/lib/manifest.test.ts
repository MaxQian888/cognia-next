import { readFile } from "node:fs/promises"

/**
 * The manifest is the product's security claim, so it is asserted rather than
 * reviewed.
 *
 * Every entry here corresponds to a promise in ADR-0154 §1. A permission added
 * by accident — or by a future feature that forgot the ADR — fails this suite
 * instead of shipping and changing what Chrome tells the user at install time.
 */
/**
 * The config with its comments removed.
 *
 * Every rule below is a "this string must not appear" assertion, and this file
 * explains at length *why* each permission is absent — so an uncommented match
 * would fail on the explanation rather than on the code. Stripping first keeps
 * the assertions about what the extension declares.
 */
async function declaredConfig(): Promise<string> {
  const source = await readFile("browser-extension/wxt.config.ts", "utf8")
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

async function manifestBlock(): Promise<{ raw: string; permissions: string[] }> {
  const source = await declaredConfig()
  const raw = source.slice(source.indexOf("  manifest: {"), source.indexOf("  vite:"))
  return {
    raw,
    permissions: [...raw.matchAll(/"(sidePanel|storage|activeTab|scripting|contextMenus)"/g)].map(
      (match) => match[1]
    ),
  }
}

describe("the extension manifest", () => {
  it("asks for exactly five permissions and no more", async () => {
    const { permissions } = await manifestBlock()
    expect([...new Set(permissions)].sort()).toEqual([
      "activeTab",
      "contextMenus",
      "scripting",
      "sidePanel",
      "storage",
    ])
  })

  it("never asks for all-urls access", async () => {
    // The starter this began from had it. It would have made "read and change
    // all your data on all websites" the install prompt for a feature that
    // reads a page only when asked.
    const { raw } = await manifestBlock()
    expect(raw).not.toContain("<all_urls>")
    // The negative lookbehind matters: `optional_host_permissions` contains
    // this key as a substring, and it is precisely the version that is
    // allowed — granted during pairing, not at install.
    expect(raw).not.toMatch(/(?<!optional_)host_permissions/)
  })

  it("keeps loopback access optional, so installing grants nothing", async () => {
    const { raw } = await manifestBlock()
    expect(raw).toContain('optional_host_permissions: ["http://127.0.0.1/*"]')
  })

  it("declares no content scripts", async () => {
    // The extractor is injected per gesture through `chrome.scripting`. A
    // static content script would run on every page, forever.
    const source = await declaredConfig()
    expect(source).not.toContain("content_scripts")
    expect(source).not.toContain("matches:")
  })

  it("holds none of the permissions that would change its trust posture", async () => {
    const { raw } = await manifestBlock()
    // `debugger` in particular cannot be requested optionally, so having it at
    // all would mean asking every user for it at install.
    for (const forbidden of [
      "debugger",
      "nativeMessaging",
      "history",
      "downloads",
      "tabCapture",
      "webRequest",
      "cookies",
      "bookmarks",
      "management",
      "proxy",
    ]) {
      expect(raw).not.toContain(`"${forbidden}"`)
    }
  })

  it("refuses to run in a private window", async () => {
    // A private window is the clearest possible statement that a page is not
    // to be handed anywhere.
    const { raw } = await manifestBlock()
    expect(raw).toContain('incognito: "not_allowed"')
  })

  it("floors at the Chrome that can open a side panel from a gesture", async () => {
    // The API exists from 114, but `sidePanel.open()` from a user gesture
    // landed in 116 — and a panel the user cannot open is not the product.
    const { raw } = await manifestBlock()
    expect(raw).toContain('minimum_chrome_version: "116"')
  })

  it("ships the product icon for both the extension and its toolbar action", async () => {
    const source = await declaredConfig()
    const { raw } = await manifestBlock()
    expect(raw).toContain("icons: extensionIcons")
    expect(raw).toContain("default_icon: extensionIcons")

    for (const size of [16, 32, 48, 128]) {
      expect(source).toContain(`${size}: "/icon-${size}.png"`)
      const icon = await readFile(`browser-extension/public/icon-${size}.png`)
      expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(icon.readUInt32BE(16)).toBe(size)
      expect(icon.readUInt32BE(20)).toBe(size)
    }
  })

  it("ships both locales with identical key sets", async () => {
    const [en, zh] = await Promise.all(
      ["en", "zh_CN"].map(async (locale) =>
        JSON.parse(
          await readFile(`browser-extension/public/_locales/${locale}/messages.json`, "utf8")
        )
      )
    )
    // `lint:i18n` only scans `components|app|hooks`, so it cannot see these.
    // Parity is asserted here or nowhere.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(en).length).toBeGreaterThan(0)
    for (const key of Object.keys(en)) {
      expect(typeof zh[key].message).toBe("string")
      expect(zh[key].message.length).toBeGreaterThan(0)
    }
  })
})
