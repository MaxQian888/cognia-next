/** @jest-environment node */

import { hasNoLeakingPii } from "@cognia/redact"
import { REDACTED_LINE, redactForModel } from "./redact"

describe("redactForModel", () => {
  it("returns clean text unchanged", () => {
    const text = "# Rules\n\n- Run pnpm typecheck after editing TypeScript."
    expect(redactForModel(text)).toBe(text)
  })

  it("redacts personal data and keys without moving any line", () => {
    const text =
      "line one\nAsk max@example.com before merging\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nlast"
    const out = redactForModel(text)
    expect(out).not.toBeNull()
    expect(out!.split("\n")).toHaveLength(4)
    expect(out).not.toContain("max@example.com")
    expect(out!.split("\n")[0]).toBe("line one")
    expect(out!.split("\n")[3]).toBe("last")
    expect(hasNoLeakingPii(out!)).toBe(true)
  })

  it("blanks a multi-line key block line by line", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaFZ0hYz6l6vVq5M",
      "-----END RSA PRIVATE KEY-----",
    ]
    const text = ["before", ...pem, "after"].join("\n")
    const out = redactForModel(text)
    expect(out).not.toBeNull()
    const lines = out!.split("\n")
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe("before")
    expect(lines[4]).toBe("after")
    expect(hasNoLeakingPii(out!)).toBe(true)
    expect(
      lines.slice(1, 4).every((line) => line === REDACTED_LINE || !line.includes("MIIE"))
    ).toBe(true)
  })
})
