import {
  containsSensitiveText,
  evidenceText,
  isSensitiveFieldName,
  redactSensitiveText,
  redactSensitiveValue,
  type SreLogEvidence,
} from "./evidence"

const LOG: SreLogEvidence = {
  id: "log_001",
  source: "logs",
  sourceKind: "json",
  time: "2026-08-04T12:02:09.113Z",
  service: "gateway",
  raw: {
    event: "request.accepted",
    tenant_id: "t-001",
    user_id: "u-123",
    api_key_id: "ak_789",
    client_ip: "10.1.2.3",
    note: "caller ak_live42 from 192.168.0.7 as u-9",
  },
}

describe("isSensitiveFieldName", () => {
  it.each([
    "api_key",
    "api-key-id",
    "token",
    "secret",
    "authorization",
    "password",
    "tenant_id",
    "user-id",
    "client_ip",
    "remote_ip_address",
  ])("refuses to facet by %s", (field) => expect(isSensitiveFieldName(field)).toBe(true))

  it.each(["service", "status", "provider", "latency_ms"])("allows %s", (field) =>
    expect(isSensitiveFieldName(field)).toBe(false)
  )
})

describe("redactSensitiveText", () => {
  it("masks API keys, subject ids and IPv4 addresses", () => {
    expect(redactSensitiveText("caller ak_live42 from 192.168.0.7 as u-9 in t-001")).toBe(
      "caller ak_[redacted] from [ip-redacted] as [subject-redacted] in [subject-redacted]"
    )
  })

  it("leaves ordinary text alone", () => {
    expect(redactSensitiveText("fallback qwen-vllm-a to qwen-vllm-b")).toBe(
      "fallback qwen-vllm-a to qwen-vllm-b"
    )
  })
})

describe("redactSensitiveValue", () => {
  it("replaces sensitive keys wholesale and scrubs every other string", () => {
    expect(redactSensitiveValue(LOG.raw)).toEqual({
      event: "request.accepted",
      tenant_id: "[redacted]",
      user_id: "[redacted]",
      api_key_id: "[redacted]",
      client_ip: "[redacted]",
      note: "caller ak_[redacted] from [ip-redacted] as [subject-redacted]",
    })
  })

  it("walks arrays and nested objects and keeps non-strings", () => {
    expect(
      redactSensitiveValue([{ nested: { token: "x", count: 3, ok: true } }, "10.0.0.1", null])
    ).toEqual([{ nested: { token: "[redacted]", count: 3, ok: true } }, "[ip-redacted]", null])
  })
})

describe("evidenceText", () => {
  it("serialises evidence for matching without any protected value", () => {
    const text = evidenceText(LOG)
    expect(text).toContain("request.accepted")
    for (const leaked of ["t-001", "u-123", "ak_789", "10.1.2.3", "ak_live42", "192.168.0.7"]) {
      expect(text).not.toContain(leaked)
    }
  })
})

describe("containsSensitiveText", () => {
  it.each([
    "api_key leaked",
    "caller ak_live42",
    "subject u-12",
    "peer 10.1.2.3",
    "the authorization header",
  ])("flags %s", (text) => expect(containsSensitiveText(text)).toBe(true))

  it("passes clean timeline prose, repeatedly (global regex state is reset)", () => {
    for (let run = 0; run < 3; run += 1) {
      expect(containsSensitiveText("gateway fell back to qwen-vllm-b after 45 s")).toBe(false)
      expect(containsSensitiveText("peer 10.1.2.3")).toBe(true)
    }
  })
})
