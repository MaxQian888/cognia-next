import { parseJsonPath, readJsonPath, readJsonPathString } from "./json-path"

describe("parseJsonPath", () => {
  it("splits dot notation", () => {
    expect(parseJsonPath("a.b.c")).toEqual(["a", "b", "c"])
  })

  it("normalises bracket indices into segments", () => {
    expect(parseJsonPath("images[0].url")).toEqual(["images", "0", "url"])
  })

  it("drops empty segments from sloppy input", () => {
    expect(parseJsonPath(".a..b.")).toEqual(["a", "b"])
  })

  it("returns nothing for an empty path", () => {
    expect(parseJsonPath("")).toEqual([])
    expect(parseJsonPath("   ")).toEqual([])
  })
})

describe("readJsonPath", () => {
  const doc = {
    images: [{ url: "https://example.test/a.jpg", title: "A" }, { url: "b.jpg" }],
    data: { today: { image: "c.jpg", empty: "" } },
    count: 3,
  }

  it("reads a nested object value", () => {
    expect(readJsonPath(doc, "data.today.image")).toBe("c.jpg")
  })

  it("indexes into arrays with both notations", () => {
    expect(readJsonPath(doc, "images.0.url")).toBe("https://example.test/a.jpg")
    expect(readJsonPath(doc, "images[1].url")).toBe("b.jpg")
  })

  it("returns undefined rather than throwing on a path that does not resolve", () => {
    // A provider that changed shape is an ordinary runtime outcome the caller
    // reports as `no-image`, not an exception to catch.
    expect(readJsonPath(doc, "images.9.url")).toBeUndefined()
    expect(readJsonPath(doc, "nope.at.all")).toBeUndefined()
    expect(readJsonPath(doc, "")).toBeUndefined()
  })

  it("refuses a non-numeric index into an array", () => {
    expect(readJsonPath(doc, "images.url")).toBeUndefined()
  })

  it("refuses to traverse into a primitive", () => {
    expect(readJsonPath(doc, "count.toFixed")).toBeUndefined()
  })

  it("refuses prototype-chain segments", () => {
    // The path is untrusted input. Reading a prototype was never what a
    // wallpaper URL lookup meant.
    expect(readJsonPath(doc, "__proto__")).toBeUndefined()
    expect(readJsonPath(doc, "data.constructor")).toBeUndefined()
    expect(readJsonPath(doc, "data.__proto__.polluted")).toBeUndefined()
    expect(readJsonPath(doc, "images.0.prototype")).toBeUndefined()
  })

  it("does not read inherited properties", () => {
    // An `in` check would have found `toString`. Testing own properties keeps
    // the lookup to what the remote host actually sent.
    expect(readJsonPath(doc, "data.toString")).toBeUndefined()
  })

  it("survives null and undefined mid-path", () => {
    expect(readJsonPath({ a: null }, "a.b")).toBeUndefined()
    expect(readJsonPath(undefined, "a")).toBeUndefined()
  })
})

describe("readJsonPathString", () => {
  it("returns a trimmed string", () => {
    expect(readJsonPathString({ a: "  x  " }, "a")).toBe("x")
  })

  it("rejects a non-string value", () => {
    expect(readJsonPathString({ a: 5 }, "a")).toBeUndefined()
    expect(readJsonPathString({ a: { b: 1 } }, "a")).toBeUndefined()
  })

  it("treats a whitespace-only value as missing", () => {
    expect(readJsonPathString({ a: "   " }, "a")).toBeUndefined()
  })
})
