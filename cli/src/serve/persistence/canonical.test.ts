import { canonicalJson, decodeKey, encodeKey, hashRows, sha256Hex } from "./canonical"

describe("encodeKey", () => {
  it("keeps disjoint IndexedDB key types disjoint", () => {
    expect(encodeKey(1)).not.toBe(encodeKey("1"))
    expect(encodeKey(new Date(1))).not.toBe(encodeKey(1))
    expect(encodeKey([1])).not.toBe(encodeKey(1))
  })

  it("does not alias nested arrays with flat ones", () => {
    expect(encodeKey([["a"], "b"])).not.toBe(encodeKey(["a", "b"]))
  })

  it("is stable for equal keys", () => {
    expect(encodeKey(["a", 2])).toBe(encodeKey(["a", 2]))
  })

  it("encodes binary keys", () => {
    const buffer = Uint8Array.from([1, 2, 3])
    expect(encodeKey(buffer)).toBe(encodeKey(buffer.buffer))
  })

  it("falls back to canonical JSON for out-of-key-space values", () => {
    expect(encodeKey({ b: 1, a: 2 })).toBe(`j:${canonicalJson({ a: 2, b: 1 })}`)
  })
})

describe("decodeKey", () => {
  it.each([
    ["number", 42],
    ["negative number", -7.5],
    ["string", "hello"],
    ["empty array", [] as unknown[]],
    ["compound array", ["a", 2] as unknown[]],
    ["nested array", [["a"], "b"] as unknown[]],
  ])("round-trips a %s key", (_label, key) => {
    expect(decodeKey(encodeKey(key))).toEqual(key)
  })

  it("round-trips a date key", () => {
    const key = new Date(1_700_000_000_000)
    expect(decodeKey(encodeKey(key))).toEqual(key)
  })

  it("returns unknown encodings verbatim rather than throwing", () => {
    expect(decodeKey("??unknown")).toBe("??unknown")
  })
})

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}')
  })

  it("drops undefined members exactly as JSON.stringify does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]")
  })

  it("marks dates so they cannot alias their ISO string", () => {
    expect(canonicalJson(new Date(0))).toBe('{"__date":"1970-01-01T00:00:00.000Z"}')
  })
})

describe("hashRows", () => {
  it("is insensitive to insertion order", () => {
    expect(hashRows({ a: 1, b: 2 })).toBe(hashRows({ b: 2, a: 1 }))
  })

  it("changes when a value changes", () => {
    expect(hashRows({ a: 1 })).not.toBe(hashRows({ a: 2 }))
  })

  it("changes when a key is added", () => {
    expect(hashRows({ a: 1 })).not.toBe(hashRows({ a: 1, b: 1 }))
  })

  it("does not confuse a key/value swap", () => {
    expect(hashRows({ a: "b" })).not.toBe(hashRows({ b: "a" }))
  })
})

describe("sha256Hex", () => {
  it("hashes UTF-8 bytes", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })
})
