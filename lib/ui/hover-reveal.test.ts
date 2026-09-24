import {
  HOVER_REVEAL_CONTROL_BASE_CLASS,
  HOVER_REVEAL_CONTROL_CLASS,
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_GROUP_BASE_CLASS,
  HOVER_REVEAL_GROUP_CLASS,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "./hover-reveal"

const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean)

describe("hover reveal policy", () => {
  it("reveals a group on hover, focus within, an open popup, and coarse pointers", () => {
    const classes = tokens(HOVER_REVEAL_GROUP_CLASS)
    expect(classes).toContain("opacity-0")
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.group) {
      expect(classes).toContain(variant)
    }
  })

  it("reveals a single control on hover, keyboard focus, its open popup, and coarse pointers", () => {
    const classes = tokens(HOVER_REVEAL_CONTROL_CLASS)
    expect(classes).toContain("opacity-0")
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.control) {
      expect(classes).toContain(variant)
    }
  })

  it("keeps the base spellings equal to the full policies minus the unnamed hover path", () => {
    const sorted = (classes: string) => tokens(classes).sort()
    expect(sorted(`${HOVER_REVEAL_GROUP_BASE_CLASS} group-hover:opacity-100`)).toEqual(
      sorted(HOVER_REVEAL_GROUP_CLASS)
    )
    expect(sorted(`${HOVER_REVEAL_CONTROL_BASE_CLASS} group-hover:opacity-100`)).toEqual(
      sorted(HOVER_REVEAL_CONTROL_CLASS)
    )
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.groupBase) {
      expect(tokens(HOVER_REVEAL_GROUP_BASE_CLASS)).toContain(variant)
    }
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.controlBase) {
      expect(tokens(HOVER_REVEAL_CONTROL_BASE_CLASS)).toContain(variant)
    }
    // A named-group surface supplies its own hover; the base must not smuggle
    // in the unnamed one, which would also fire on an unrelated outer `group`.
    expect(tokens(HOVER_REVEAL_GROUP_BASE_CLASS)).not.toContain("group-hover:opacity-100")
    expect(tokens(HOVER_REVEAL_CONTROL_BASE_CLASS)).not.toContain("group-hover:opacity-100")
  })

  it("only ever fades: a quiet control stays focusable and clickable", () => {
    for (const policy of [
      HOVER_REVEAL_GROUP_CLASS,
      HOVER_REVEAL_CONTROL_CLASS,
      HOVER_REVEAL_GROUP_BASE_CLASS,
      HOVER_REVEAL_CONTROL_BASE_CLASS,
    ]) {
      const classes = tokens(policy)
      for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
        expect(classes).not.toContain(forbidden)
      }
    }
  })
})
