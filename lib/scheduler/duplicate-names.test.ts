import { duplicateNames, scheduledIdentityLabel } from "./duplicate-names"

describe("duplicateNames", () => {
  it("returns only names carried by more than one item", () => {
    const shared = duplicateNames([
      { name: "demo-heartbeat" },
      { name: "Nightly backup" },
      { name: "demo-heartbeat" },
    ])
    expect([...shared]).toEqual(["demo-heartbeat"])
  })

  it("is case-sensitive and empty for unique or no items", () => {
    expect(duplicateNames([{ name: "Sync" }, { name: "sync" }]).size).toBe(0)
    expect(duplicateNames([]).size).toBe(0)
  })

  it("accepts any iterable", () => {
    function* rows() {
      yield { name: "a" }
      yield { name: "a" }
    }
    expect(duplicateNames(rows()).has("a")).toBe(true)
  })
})

describe("scheduledIdentityLabel", () => {
  it("joins the kind label and the stable source id", () => {
    expect(scheduledIdentityLabel("App", "task-123")).toBe("App · task-123")
  })
})
