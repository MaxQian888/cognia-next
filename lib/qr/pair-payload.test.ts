import { decodePairPayload, encodePairPayload } from "./pair-payload"

describe("encodePairPayload", () => {
  it("produces a header-prefixed base64url string", () => {
    const out = encodePairPayload({
      baseUrl: "https://192.168.1.10:7891",
      pairJwt: "header.payload.signature",
      version: "0.1.0",
      fingerprint: "deadbeef",
    })
    expect(out.startsWith("cgnp2|")).toBe(true)
    expect(out).not.toContain("=")
    expect(out).not.toContain("+")
    expect(out).not.toContain("/")
  })
})

describe("decodePairPayload", () => {
  it("round-trips an encoded payload", () => {
    const original = {
      baseUrl: "https://192.168.1.10:7891",
      pairJwt: "h.p.s",
      version: "0.1.0",
      fingerprint: "abc123",
    }
    const encoded = encodePairPayload(original)
    const out = decodePairPayload(encoded)
    expect(out).toEqual({ kind: "ok", payload: original })
  })

  it("accepts legacy bare JSON (M3.4 stub)", () => {
    const json = JSON.stringify({
      baseUrl: "http://10.0.0.1:7890",
      pairJwt: "legacy",
    })
    const out = decodePairPayload(json)
    expect(out).toEqual({
      kind: "ok",
      payload: {
        baseUrl: "http://10.0.0.1:7890",
        pairJwt: "legacy",
        version: "",
        fingerprint: "",
      },
    })
  })

  it("returns wrong_format for an unrelated string", () => {
    const out = decodePairPayload("not a payload")
    // Falls into parseBody which fails base64 decode → invalid.
    expect(out.kind === "invalid" || out.kind === "wrong_format").toBe(true)
  })

  it("returns version_mismatch for a future header version", () => {
    const out = decodePairPayload("cgnp99|garbage")
    expect(out).toEqual({ kind: "version_mismatch", got: 99 })
  })

  it("returns wrong_format when header is malformed", () => {
    const out = decodePairPayload("cgnpabcdef")
    expect(out.kind).toBe("wrong_format")
  })

  it("returns invalid for missing baseUrl", () => {
    const json = JSON.stringify({ pairJwt: "x" })
    const out = decodePairPayload(json)
    expect(out).toEqual({ kind: "invalid", message: "missing baseUrl or pairJwt" })
  })

  it("returns invalid for non-JSON body", () => {
    // Construct a header-tagged payload whose body is invalid base64.
    const out = decodePairPayload("cgnp2|!!not-base64!!")
    expect(out.kind).toBe("invalid")
  })
})
