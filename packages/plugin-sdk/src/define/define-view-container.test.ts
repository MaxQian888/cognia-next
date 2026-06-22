import { defineViewContainer } from "./define-view-container"

describe("defineViewContainer", () => {
  it("returns the container definition unchanged (pure pass-through)", () => {
    const c = defineViewContainer({ id: "explorer", title: "Explorer", icon: "folder-tree" })
    expect(c).toEqual({ id: "explorer", title: "Explorer", icon: "folder-tree" })
  })

  it("preserves optional location/order/when fields", () => {
    const c = defineViewContainer({
      id: "search",
      title: "Search",
      location: "panel",
      order: 5,
      when: "project.active",
    })
    expect(c).toMatchObject({ location: "panel", order: 5, when: "project.active" })
  })
})
