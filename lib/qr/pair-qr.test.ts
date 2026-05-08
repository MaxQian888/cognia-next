import { encodePairQrPayload, parsePairQrPayload } from "./pair-qr"

describe("parsePairQrPayload", () => {
  it("parses a v1 payload", () => {
    const raw = JSON.stringify({
      baseUrl: "http://test:7890",
      pairJwt: "aaa.bbb.ccc",
      v: 1,
    })
    expect(parsePairQrPayload(raw)).toEqual({
      baseUrl: "http://test:7890",
      pairJwt: "aaa.bbb.ccc",
      v: 1,
    })
  })

  it("defaults v to 1 when omitted", () => {
    const raw = JSON.stringify({ baseUrl: "u", pairJwt: "j" })
    expect(parsePairQrPayload(raw)?.v).toBe(1)
  })

  it("returns null on empty input", () => {
    expect(parsePairQrPayload("")).toBeNull()
  })

  it("returns null on non-JSON input", () => {
    expect(parsePairQrPayload("not json")).toBeNull()
  })

  it("returns null on JSON arrays", () => {
    expect(parsePairQrPayload("[]")).toBeNull()
  })

  it("returns null on JSON nulls", () => {
    expect(parsePairQrPayload("null")).toBeNull()
  })

  it("returns null when baseUrl is missing", () => {
    expect(parsePairQrPayload(JSON.stringify({ pairJwt: "j" }))).toBeNull()
  })

  it("returns null when pairJwt is missing", () => {
    expect(parsePairQrPayload(JSON.stringify({ baseUrl: "u" }))).toBeNull()
  })

  it("returns null when baseUrl is empty", () => {
    expect(parsePairQrPayload(JSON.stringify({ baseUrl: "", pairJwt: "j" }))).toBeNull()
  })

  it("returns null when pairJwt is empty", () => {
    expect(parsePairQrPayload(JSON.stringify({ baseUrl: "u", pairJwt: "" }))).toBeNull()
  })

  it("returns null when v is not a number", () => {
    expect(parsePairQrPayload(JSON.stringify({ baseUrl: "u", pairJwt: "j", v: "1" }))).toBeNull()
  })

  it("survives a round-trip through encode/parse", () => {
    const payload = { baseUrl: "http://x", pairJwt: "j.j.j", v: 1 }
    expect(parsePairQrPayload(encodePairQrPayload(payload))).toEqual(payload)
  })
})

describe("encodePairQrPayload", () => {
  it("emits a JSON string with all three keys", () => {
    const out = encodePairQrPayload({ baseUrl: "u", pairJwt: "j" })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual({ baseUrl: "u", pairJwt: "j", v: 1 })
  })
})
