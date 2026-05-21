import { prefixPluginKind } from "./kind-prefix"

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
