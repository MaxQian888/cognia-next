import { KIND_SCOPES, type GlobalSearchKind } from "@/lib/global-search/types"

import { KIND_ICONS, kindIcon } from "./kind-icons"

describe("kind icons", () => {
  it("has an icon for every kind", () => {
    for (const kind of Object.keys(KIND_SCOPES) as GlobalSearchKind[]) {
      expect(typeof KIND_ICONS[kind]).toBeDefined()
      expect(kindIcon(kind)).toBe(KIND_ICONS[kind])
    }
  })

  it("gives IM contacts their own icon, distinct from conversations", () => {
    expect(KIND_ICONS["inbox-contact"]).not.toBe(KIND_ICONS["inbox-conversation"])
  })

  it("falls back to the command icon for an unknown kind", () => {
    expect(kindIcon("nope" as GlobalSearchKind)).toBe(KIND_ICONS.action)
  })
})
