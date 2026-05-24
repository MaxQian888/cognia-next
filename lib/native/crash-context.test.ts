/**
 * @jest-environment node
 *
 * Tests for native/crash-context — the redaction-gated frontend → Rust context
 * bridge. The redaction pass is the security-critical part: secrets must never
 * reach the backend in the clear.
 */

import { invoke } from "@tauri-apps/api/core"

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

import { redactConfig, pushCrashContext, pushCrashBreadcrumb } from "./crash-context"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  isTauriValue = false
  mockedInvoke.mockReset()
})

describe("redactConfig", () => {
  it("scrubs secrets and PII in nested string values", () => {
    const out = redactConfig({
      theme: "dark",
      token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      contact: "alice@example.com",
      nested: { note: "ping me at bob@example.org" },
      list: ["plain", "sk-ant-secret-key-value-1234567890abcd"],
    }) as Record<string, unknown>

    expect(out.theme).toBe("dark")
    expect(String(out.token)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz")
    expect(String(out.token)).toMatch(/<API_KEY_\d{3}>/)
    expect(String(out.contact)).not.toContain("alice@example.com")
    expect((out.nested as Record<string, unknown>).note).not.toContain("bob@example.org")
    expect((out.list as string[])[0]).toBe("plain")
    expect((out.list as string[])[1]).toMatch(/<API_KEY_\d{3}>/)
  })

  it("preserves non-string primitives and drops non-serializable values", () => {
    const out = redactConfig({
      count: 5,
      enabled: true,
      missing: null,
      fn: () => 1,
    }) as Record<string, unknown>
    expect(out.count).toBe(5)
    expect(out.enabled).toBe(true)
    expect(out.missing).toBeNull()
    expect(out.fn).toBeNull()
  })
})

describe("pushCrashContext", () => {
  it("is a no-op off the desktop runtime", async () => {
    await pushCrashContext({ theme: "dark" })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("sends a redacted config under Tauri", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce(undefined)
    await pushCrashContext({ token: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" })
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockedInvoke.mock.calls[0]
    expect(cmd).toBe("crash_set_context")
    const config = (args as { config: Record<string, unknown> }).config
    expect(String(config.token)).toMatch(/<API_KEY_\d{3}>/)
  })

  it("swallows invoke errors", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    await expect(pushCrashContext({ theme: "dark" })).resolves.toBeUndefined()
  })
})

describe("pushCrashBreadcrumb", () => {
  it("redacts the message before sending", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce(undefined)
    await pushCrashBreadcrumb("login as carol@example.com", "warn")
    const [cmd, args] = mockedInvoke.mock.calls[0]
    expect(cmd).toBe("crash_push_breadcrumb")
    const { message, level } = args as { message: string; level: string }
    expect(message).not.toContain("carol@example.com")
    expect(level).toBe("warn")
  })

  it("is a no-op off the desktop runtime", async () => {
    await pushCrashBreadcrumb("hello")
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
