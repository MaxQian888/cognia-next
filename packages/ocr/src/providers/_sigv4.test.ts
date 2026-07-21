import { signRequest } from "./_sigv4"

const FIXED_DATE = new Date("2024-01-15T12:00:00.000Z")

describe("signRequest", () => {
  it("attaches Authorization, x-amz-date, host, and x-amz-content-sha256", async () => {
    const signed = await signRequest(
      { accessKeyId: "AKIA", secretAccessKey: "secret" },
      {
        method: "POST",
        service: "textract",
        region: "us-east-1",
        url: "https://textract.us-east-1.amazonaws.com/",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "Textract.DetectDocumentText",
        },
        body: '{"Document":{"Bytes":""}}',
        now: FIXED_DATE,
      }
    )
    expect(signed.headers["host"]).toBe("textract.us-east-1.amazonaws.com")
    expect(signed.headers["x-amz-date"]).toBe("20240115T120000Z")
    expect(signed.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/)
    const auth = signed.headers["authorization"]!
    expect(auth.startsWith("AWS4-HMAC-SHA256 ")).toBe(true)
    expect(auth).toContain("Credential=AKIA/20240115/us-east-1/textract/aws4_request")
    expect(auth).toContain("SignedHeaders=")
    expect(auth).toContain("Signature=")
  })

  it("is deterministic for the same inputs", async () => {
    const opts = {
      method: "POST" as const,
      service: "textract",
      region: "us-east-1",
      url: "https://textract.us-east-1.amazonaws.com/",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "Textract.DetectDocumentText",
      },
      body: '{"a":1}',
      now: FIXED_DATE,
    }
    const a = await signRequest({ accessKeyId: "AKIA", secretAccessKey: "s" }, opts)
    const b = await signRequest({ accessKeyId: "AKIA", secretAccessKey: "s" }, opts)
    expect(a.headers["authorization"]).toBe(b.headers["authorization"])
  })

  it("changes the signature when the body changes", async () => {
    const base = {
      method: "POST" as const,
      service: "textract",
      region: "us-east-1",
      url: "https://textract.us-east-1.amazonaws.com/",
      headers: { "X-Amz-Target": "Textract.DetectDocumentText" },
      now: FIXED_DATE,
    }
    const a = await signRequest(
      { accessKeyId: "AKIA", secretAccessKey: "s" },
      { ...base, body: '{"a":1}' }
    )
    const b = await signRequest(
      { accessKeyId: "AKIA", secretAccessKey: "s" },
      { ...base, body: '{"a":2}' }
    )
    expect(a.headers["authorization"]).not.toBe(b.headers["authorization"])
  })

  it("attaches x-amz-security-token when a session token is present", async () => {
    const signed = await signRequest(
      { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "abc" },
      {
        method: "POST",
        service: "textract",
        region: "us-east-1",
        url: "https://textract.us-east-1.amazonaws.com/",
        headers: { "X-Amz-Target": "Textract.DetectDocumentText" },
        body: "{}",
        now: FIXED_DATE,
      }
    )
    expect(signed.headers["x-amz-security-token"]).toBe("abc")
    expect(signed.headers["authorization"]).toContain("x-amz-security-token")
  })

  it("encodes query parameters via RFC 3986", async () => {
    // Should not throw; covers the query canonicalization path.
    const signed = await signRequest(
      { accessKeyId: "AKIA", secretAccessKey: "s" },
      {
        method: "GET",
        service: "s3",
        region: "us-east-1",
        url: "https://example.com/path?b=hello world&a=2",
        headers: {},
        body: "",
        now: FIXED_DATE,
      }
    )
    expect(signed.headers["authorization"]).toContain("Signature=")
  })

  it("accepts a Uint8Array body and hashes it", async () => {
    const signed = await signRequest(
      { accessKeyId: "AKIA", secretAccessKey: "s" },
      {
        method: "POST",
        service: "textract",
        region: "us-east-1",
        url: "https://textract.us-east-1.amazonaws.com/",
        headers: {},
        body: new Uint8Array([1, 2, 3]),
        now: FIXED_DATE,
      }
    )
    expect(signed.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/)
  })
})
