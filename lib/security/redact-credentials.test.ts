import { redactCredentialText, redactCredentialUrl } from "./redact-credentials"

it("replaces a bare bearer token", () => {
  expect(redactCredentialText("sent Bearer abc.def-123 upstream")).toBe(
    "sent Bearer [REDACTED] upstream"
  )
})

it("replaces a header line, whichever pattern claims it", () => {
  const out = redactCredentialText("Authorization: Bearer abc.def-123")
  expect(out).not.toContain("abc.def-123")
})

it("replaces a JWT anywhere in the line", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-part"
  expect(redactCredentialText(`token=${jwt} done`)).toContain("[REDACTED]")
  expect(redactCredentialText(`printed ${jwt}`)).toBe("printed [REDACTED_JWT]")
})

it.each([
  "api_key: sk-live-1234",
  "CLOUDFLARE_TOKEN=abcdef",
  'secret: "hunter2"',
  "refresh-token = xyz",
])("replaces the value of a credential-shaped field: %s", (line) => {
  const out = redactCredentialText(line)
  expect(out).toContain("[REDACTED]")
  expect(out).not.toMatch(/sk-live-1234|abcdef|hunter2|xyz/)
})

it("replaces email addresses", () => {
  expect(redactCredentialText("failed for a.b+c@example.co.uk")).toBe("failed for [REDACTED_EMAIL]")
})

it("leaves ordinary build output alone", () => {
  const line = "vite v5.4.0 building for production... 42 modules transformed."
  expect(redactCredentialText(line)).toBe(line)
})

it("redacts sensitive query values without eating the rest of the query", () => {
  const out = redactCredentialUrl("https://api.example.com/v4?token=abc&page=2")
  expect(out).not.toContain("abc")
  expect(out).toContain("page=2")
})

it("redacts a credential suffixed onto a longer variable name", () => {
  // `\b` does not match between `_` and `TOKEN`, so this shape — exactly what
  // a build script prints — used to go through untouched.
  for (const line of [
    "CLOUDFLARE_API_TOKEN=abcdef",
    "MY_SECRET: hunter2",
    "npm_config_registry_authToken=xyz",
  ]) {
    const out = redactCredentialText(line)
    expect(out).toContain("[REDACTED]")
    expect(out).not.toMatch(/abcdef|hunter2|xyz/)
  }
})

it("falls back to text redaction for a non-URL", () => {
  expect(redactCredentialUrl("password: hunter2")).toBe("password: [REDACTED]")
})
