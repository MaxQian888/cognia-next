import {
  graphNodeVariants,
  listContainerVariants,
  listItemVariants,
  staticIf,
  viewSwitchVariants,
} from "./scheduler-motion"

describe("scheduler-motion variants", () => {
  it("defines hidden/show states for list + view variants", () => {
    expect(listContainerVariants.show).toBeDefined()
    expect(listItemVariants.hidden).toMatchObject({ opacity: 0 })
    expect(viewSwitchVariants.exit).toBeDefined()
    expect(graphNodeVariants.hidden).toMatchObject({ scale: 0.9 })
  })
})

describe("staticIf", () => {
  it("returns the variants unchanged when motion is allowed", () => {
    expect(staticIf(false, listItemVariants)).toBe(listItemVariants)
    expect(staticIf(null, listItemVariants)).toBe(listItemVariants)
  })

  it("collapses to the settled state when reduced motion is preferred", () => {
    const collapsed = staticIf(true, listItemVariants)
    expect(collapsed.hidden).toBe(collapsed.show)
    expect(collapsed.hidden).toBe(listItemVariants.show)
  })

  it("falls back to an empty settled state when no show variant exists", () => {
    const collapsed = staticIf(true, { hidden: { opacity: 0 } })
    expect(collapsed.show).toEqual({})
  })
})
