import { prefixPluginKind, unprefixPluginKind } from "./kind-prefix"

describe("prefixPluginKind", () => {
  it("preserves the leading trigger. segment", () => {
    expect(prefixPluginKind("foo", "trigger.bar")).toBe("trigger.foo.bar")
  })

  it("namespaces flat kinds under pluginId", () => {
    expect(prefixPluginKind("foo", "myNode")).toBe("foo.myNode")
  })

  it("handles nested dotted kinds", () => {
    expect(prefixPluginKind("foo", "trigger.deep.nested.bar")).toBe("trigger.foo.deep.nested.bar")
    expect(prefixPluginKind("foo", "category.sub")).toBe("foo.category.sub")
  })
})

describe("unprefixPluginKind", () => {
  it("strips the pluginId from a flat-prefixed kind", () => {
    expect(unprefixPluginKind("foo", "foo.myNode")).toBe("myNode")
    expect(unprefixPluginKind("foo", "foo.category.sub")).toBe("category.sub")
  })

  it("restores the leading trigger. segment", () => {
    expect(unprefixPluginKind("foo", "trigger.foo.bar")).toBe("trigger.bar")
    expect(unprefixPluginKind("foo", "trigger.foo.deep.nested.bar")).toBe("trigger.deep.nested.bar")
  })

  it("returns the kind unchanged when it carries no matching prefix", () => {
    expect(unprefixPluginKind("foo", "action.character.send")).toBe("action.character.send")
    expect(unprefixPluginKind("foo", "bar.baz")).toBe("bar.baz")
  })

  it("round-trips with prefixPluginKind", () => {
    for (const raw of ["myNode", "category.sub", "trigger.bar", "trigger.deep.nested.bar"]) {
      expect(unprefixPluginKind("foo", prefixPluginKind("foo", raw))).toBe(raw)
    }
  })
})
