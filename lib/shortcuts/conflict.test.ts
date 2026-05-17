import { findConflicts } from "./conflict"

describe("findConflicts", () => {
  it("returns an empty object when every chord is unique", () => {
    const conflicts = findConflicts({
      "a.foo": "Ctrl+S",
      "b.bar": "Ctrl+Z",
    })
    expect(conflicts).toEqual({})
  })

  it("groups ids that share a normalized chord", () => {
    const conflicts = findConflicts({
      "a.foo": "Ctrl+S",
      "b.bar": "ctrl + s",
      "c.baz": "Shift+Ctrl+K",
    })
    expect(conflicts).toEqual({ "ctrl+s": ["a.foo", "b.bar"] })
  })

  it("does not flag a chord that occurs only once even if normalisation reshuffles modifiers", () => {
    const conflicts = findConflicts({
      "a.foo": "Shift+Ctrl+K",
    })
    expect(conflicts).toEqual({})
  })

  it("collects three-way conflicts under one key", () => {
    const conflicts = findConflicts({
      "a.foo": "Ctrl+K",
      "b.bar": "ctrl+k",
      "c.baz": "CTRL + K",
    })
    expect(conflicts["ctrl+k"]).toEqual(["a.foo", "b.bar", "c.baz"])
  })
})
