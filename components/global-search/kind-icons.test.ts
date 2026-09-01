import { KIND_SCOPES, type GlobalSearchKind } from "@/lib/global-search/types"

import { KIND_ICONS, kindIcon } from "./kind-icons"

describe("kind icons", () => {
  /**
   * `KIND_ICONS` is typed as a full Record, so a missing kind is supposed to be
   * a compile error. It is not, in practice: full-repo `tsc` OOMs before it
   * checks anything, and `squad` and `site` sat absent here for as long as
   * those kinds existed. This walk over `KIND_SCOPES` is the check that holds.
   *
   * `toBeDefined()` on a `typeof` was the original assertion and could never
   * fail, since `typeof` always returns a string. The real subject is the icon.
   */
  it("has an icon for every kind", () => {
    const kinds = Object.keys(KIND_SCOPES) as GlobalSearchKind[]
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      expect(KIND_ICONS[kind]).toBeDefined()
      expect(kindIcon(kind)).toBe(KIND_ICONS[kind])
    }
  })

  /**
   * A Squad and a guild of Characters are different things that both surface in
   * one result list, and the row text alone does not separate them.
   */
  it("gives a Squad its own icon, distinct from a Character team", () => {
    expect(KIND_ICONS.squad).not.toBe(KIND_ICONS.team)
  })

  it("gives IM contacts their own icon, distinct from conversations", () => {
    expect(KIND_ICONS["inbox-contact"]).not.toBe(KIND_ICONS["inbox-conversation"])
  })

  it("falls back to the command icon for an unknown kind", () => {
    expect(kindIcon("nope" as GlobalSearchKind)).toBe(KIND_ICONS.action)
  })
})
