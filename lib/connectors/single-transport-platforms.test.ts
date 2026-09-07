/**
 * @jest-environment node
 */

import en from "@/i18n/messages/en/settings/connections.json"
import zh from "@/i18n/messages/zh-CN/settings/connections.json"
import { ALL_PLATFORM_KINDS } from "@/types/connectors/platform-kind"

import {
  SINGLE_TRANSPORT_PLATFORMS,
  singleTransportPlatform,
  type SingleTransportPlatform,
} from "./single-transport-platforms"

const entries = Object.entries(SINGLE_TRANSPORT_PLATFORMS) as Array<
  [string, SingleTransportPlatform]
>

describe("SINGLE_TRANSPORT_PLATFORMS", () => {
  it("only names kinds the platform vocabulary actually has", () => {
    // A typo here is invisible: `singleTransportPlatform` would just never
    // match and the row would silently fall back to the generic wording.
    for (const [kind] of entries) {
      expect({ kind, known: ALL_PLATFORM_KINDS.includes(kind as never) }).toEqual({
        kind,
        known: true,
      })
    }
  })

  it("keeps the two causes distinct, because the remedies differ", () => {
    // `protocol` means the operator has nothing to try. `unbuilt` means there
    // is a second path that has not been written. Collapsing them into one
    // "not applicable" is what this table exists to undo.
    const byCause = (cause: string) => entries.filter(([, v]) => v.cause === cause).map(([k]) => k)
    expect(byCause("protocol").sort()).toEqual(["matrix", "wechat-personal"])
    expect(byCause("unbuilt").sort()).toEqual(["dingtalk", "wecom"])
  })

  it("resolves every reason key in both locales", () => {
    // The UI reads these through a runtime key, which `lint:i18n` cannot see,
    // so a missing one renders the dotted key path to the user.
    for (const [kind, value] of entries) {
      for (const [locale, bundle] of [
        ["en", en],
        ["zh-CN", zh],
      ] as const) {
        const table = (bundle as unknown as Record<string, Record<string, string>>).singleTransport
        expect(`${locale}/${kind}=${typeof table?.[value.reasonKey]}`).toBe(
          `${locale}/${kind}=string`
        )
      }
    }
  })

  it("carries no reason key the table does not use", () => {
    const declared = new Set(entries.map(([, v]) => v.reasonKey))
    const shipped = Object.keys(
      (en as unknown as Record<string, Record<string, string>>).singleTransport
    )
    expect(shipped.filter((k) => !declared.has(k))).toEqual([])
  })

  it("answers undefined for a platform that has a transport choice", () => {
    // Discord, QQ Official and OneBot all offer two, so the generic wording is
    // the right one for them and this table must not claim otherwise.
    for (const kind of ["discord", "qq-official", "onebot", "telegram", "slack", "lark"]) {
      expect({ kind, entry: singleTransportPlatform(kind) }).toEqual({ kind, entry: undefined })
    }
  })

  it("answers undefined for an unknown kind rather than throwing", () => {
    // Plugin-contributed kinds reach this lookup too.
    expect(singleTransportPlatform("acme-chat")).toBeUndefined()
  })
})
