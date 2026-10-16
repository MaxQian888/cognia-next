import { readFile } from "node:fs/promises"

/**
 * The manifest is the product's security claim, so it is asserted rather than
 * reviewed.
 *
 * Every entry here corresponds to a promise in ADR-0154 §1 as amended by
 * ADR-0228. A permission added
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

function listAt(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`(?<![a-z_])${key}: \\[([^\\]]*)\\]`))
  if (!match) return []
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? "")
}

async function manifestBlock(): Promise<{
  raw: string
  permissions: string[]
  optionalPermissions: string[]
  optionalHosts: string[]
}> {
  const source = await declaredConfig()
  const raw = source.slice(source.indexOf("  manifest: {"), source.indexOf("  alias:"))
  return {
    raw,
    permissions: listAt(raw, "permissions"),
    optionalPermissions: listAt(raw, "optional_permissions"),
    optionalHosts: listAt(raw, "optional_host_permissions"),
  }
}

describe("the extension manifest", () => {
  it("asks at install only for what carries no page access", async () => {
    // `alarms` and `tabGroups` have no install warning; nothing here reads a
    // page without a gesture.
    const { permissions } = await manifestBlock()
    expect([...new Set(permissions)].sort()).toEqual([
      "activeTab",
      "alarms",
      "contextMenus",
      "scripting",
      "sidePanel",
      "storage",
      "tabGroups",
    ])
  })

  it("keeps every broader grant optional, asked for by the feature that needs it", async () => {
    const { optionalPermissions } = await manifestBlock()
    expect(optionalPermissions.sort()).toEqual(["cookies", "downloads", "notifications", "tabs"])
  })

  it("never asks for all-urls access at install", async () => {
    // It would make "read and change all your data on all websites" the
    // install prompt. It exists only as an optional grant agent mode asks for.
    const { raw, optionalHosts } = await manifestBlock()
    expect(optionalHosts).toEqual(["http://127.0.0.1/*", "<all_urls>"])
    expect(raw.match(/<all_urls>/g)).toHaveLength(1)
    // The negative lookbehind matters: `optional_host_permissions` contains
    // this key as a substring, and it is precisely the version that is allowed.
    expect(raw).not.toMatch(/(?<!optional_)host_permissions/)
  })

  it("keeps loopback access optional, so installing grants nothing", async () => {
    const { optionalHosts, permissions } = await manifestBlock()
    expect(optionalHosts).toContain("http://127.0.0.1/*")
    expect(permissions.join(" ")).not.toContain("127.0.0.1")
  })

  it("suggests at most the four shortcuts Chrome honours, and the omnibox keyword", async () => {
    const { raw } = await manifestBlock()
    expect(raw.match(/suggested_key/g)).toHaveLength(4)
    for (const command of [
      "_execute_action",
      '"capture-page"',
      '"capture-selection"',
      '"capture-article"',
    ]) {
      expect(raw).toContain(command)
    }
    expect(raw).toContain('omnibox: { keyword: "cog" }')
  })

  it("declares no content scripts", async () => {
    // The extractor is injected per gesture through `chrome.scripting`. A
    // static content script would run on every page, forever.
    const source = await declaredConfig()
    expect(source).not.toContain("content_scripts")
    expect(source).not.toContain("matches:")
  })

  it("holds none of the permissions that would change its trust posture", async () => {
    const { raw, permissions } = await manifestBlock()
    // `debugger` in particular cannot be requested optionally, so having it at
    // all would mean asking every user for it at install.
    for (const forbidden of [
      "debugger",
      "nativeMessaging",
      "history",
      "tabCapture",
      "webRequest",
      "bookmarks",
      "management",
      "proxy",
    ]) {
      expect(raw).not.toContain(`"${forbidden}"`)
    }
    // These exist only as optional grants, never at install.
    for (const optionalOnly of ["tabs", "notifications", "downloads", "cookies"]) {
      expect(permissions).not.toContain(optionalOnly)
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
