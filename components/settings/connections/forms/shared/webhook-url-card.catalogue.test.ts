/**
 * @jest-environment node
 *
 * `WebhookUrlCard` resolves its keys inside a namespace handed to it at
 * runtime, which `lint:i18n` cannot see: that gate finds hard-coded strings in
 * `.tsx`, not keys that fail to resolve. A missing key here renders the dotted
 * key path to the user, which is exactly what the WeChat OA copy button did
 * before this card existed.
 *
 * So the contract is pinned here instead, against the real split message
 * sources rather than the generated aggregate, per
 * `i18n-aggregates-already-drift-at-head`.
 */

import en from "@/i18n/messages/en/settings/connections.json"
import zh from "@/i18n/messages/zh-CN/settings/connections.json"

import { WEBHOOK_URL_CARD_KEYS } from "./webhook-url-card"

/**
 * Every namespace the card is mounted with. Adding a form here without adding
 * its keys is the failure this test exists to catch, so the list is written
 * out rather than derived.
 */
const MOUNTED_NAMESPACES = [
  "lark",
  "slack",
  "telegram",
  "discord",
  "wechatOa",
  "qqOfficial",
] as const

/** Namespaces that also pass a `consoleUrl`, so they need the console keys. */
const WITH_CONSOLE = ["lark", "slack", "discord", "qqOfficial"] as const

const LOCALES: ReadonlyArray<[string, Record<string, Record<string, string>>]> = [
  ["en", en as unknown as Record<string, Record<string, string>>],
  ["zh-CN", zh as unknown as Record<string, Record<string, string>>],
]

describe("WebhookUrlCard translation catalogue", () => {
  it.each(LOCALES)("%s defines every shared key in every mounted namespace", (_locale, bundle) => {
    for (const ns of MOUNTED_NAMESPACES) {
      const sub = bundle[ns]
      expect(sub).toBeDefined()
      for (const key of WEBHOOK_URL_CARD_KEYS) {
        expect(`${ns}.${key}=${typeof sub?.[key]}`).toBe(`${ns}.${key}=string`)
        expect(sub[key].trim().length).toBeGreaterThan(0)
      }
    }
  })

  it.each(LOCALES)("%s defines the console keys wherever a console link is shown", (_l, bundle) => {
    for (const ns of WITH_CONSOLE) {
      for (const key of ["openConsole", "openConsoleAria"]) {
        expect(`${ns}.${key}=${typeof bundle[ns]?.[key]}`).toBe(`${ns}.${key}=string`)
      }
    }
  })

  it("keeps the two locales at the same key set for these namespaces", () => {
    // A key added to one locale only resolves to the dotted path for half the
    // users, which is the failure mode the parity baseline exists to stop.
    for (const ns of MOUNTED_NAMESPACES) {
      const enKeys = Object.keys(en[ns]).sort()
      const zhKeys = Object.keys(zh[ns]).sort()
      expect({ ns, keys: zhKeys }).toEqual({ ns, keys: enKeys })
    }
  })

  it("no longer carries the Discord-only spelling of the shared keys", () => {
    // Discord called this the interactions endpoint and had its own eight
    // keys. The wording stayed, the key names joined the shared vocabulary,
    // and leaving the old ones behind would let a form drift back onto them.
    for (const [, bundle] of LOCALES) {
      const discordKeys = Object.keys(bundle.discord)
      expect(discordKeys.filter((k) => k.startsWith("interactionsUrl"))).toEqual([])
    }
  })
})
