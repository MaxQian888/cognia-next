/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assertNoInlineSecret, resolveCredential } from "./credentials"

const HOME = "/home/.cognia"
const CREDENTIALS = `${HOME}/credentials.json`

function fileWith(contents: Record<string, unknown>) {
  return (absPath: string) => (absPath === CREDENTIALS ? JSON.stringify(contents) : null)
}

describe("assertNoInlineSecret", () => {
  it("passes a reference-shaped object", () => {
    expect(assertNoInlineSecret({ credentialProfileRef: "anthropic" })).toBeNull()
    expect(assertNoInlineSecret({ credentialEnv: "ANTHROPIC_API_KEY" })).toBeNull()
  })

  it("passes non-objects rather than inventing an error", () => {
    expect(assertNoInlineSecret(undefined)).toBeNull()
    expect(assertNoInlineSecret(null)).toBeNull()
    expect(assertNoInlineSecret("anthropic")).toBeNull()
  })

  it.each([
    "apiKey",
    "api_key",
    "authToken",
    "auth_token",
    "token",
    "secret",
    "password",
    "accessToken",
    "access_token",
  ])("rejects an inlined %s, which types alone cannot catch in JS callers", (field) => {
    const error = assertNoInlineSecret({ [field]: "sk-ant-live-1234" })
    expect(error).toMatchObject({ code: "config_error", detail: { fields: [field] } })
  })

  it("names every offending field at once", () => {
    const error = assertNoInlineSecret({ apiKey: "a", authToken: "b" })
    expect(error?.detail).toMatchObject({ fields: ["apiKey", "authToken"] })
  })

  it("never echoes the secret back into the error it produces", () => {
    // The error object is itself logged. Repeating the value here would
    // recreate exactly the leak this check exists to prevent.
    const error = assertNoInlineSecret({ apiKey: "sk-ant-live-DO-NOT-LOG" })
    expect(JSON.stringify(error)).not.toContain("DO-NOT-LOG")
  })

  it("ignores a field that is present but undefined", () => {
    expect(assertNoInlineSecret({ apiKey: undefined, credentialEnv: "X" })).toBeNull()
  })
})

describe("resolveCredential — environment references", () => {
  it("reads the variable the reference NAMES, not the reference itself", () => {
    const result = resolveCredential({
      ref: { credentialEnv: "MY_KEY" },
      home: HOME,
      env: { MY_KEY: "sk-live-1" },
      readFile: () => null,
    })
    expect(result).toMatchObject({ ok: true, credential: { secret: "sk-live-1" } })
  })

  it("reports provenance without the secret, so it is safe to log", () => {
    const result = resolveCredential({
      ref: { credentialEnv: "MY_KEY" },
      home: HOME,
      env: { MY_KEY: "sk-live-1" },
      readFile: () => null,
    })
    expect(result.ok && result.credential.source).toBe("env:MY_KEY")
  })

  it("fails loudly on an unset variable rather than falling through to another credential", () => {
    const result = resolveCredential({
      ref: { credentialEnv: "MISSING" },
      home: HOME,
      env: { ANTHROPIC_API_KEY: "sk-some-other-account" },
      readFile: () => null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("config_error")
    expect(result.error.message).toContain("MISSING")
  })

  it("treats a whitespace-only variable as unset", () => {
    const result = resolveCredential({
      ref: { credentialEnv: "BLANK" },
      home: HOME,
      env: { BLANK: "   " },
      readFile: () => null,
    })
    expect(result.ok).toBe(false)
  })
})

describe("resolveCredential — profile references", () => {
  it("resolves an apiKey entry from the CLI's own credentials file", () => {
    const result = resolveCredential({
      ref: { credentialProfileRef: "anthropic" },
      home: HOME,
      env: {},
      readFile: fileWith({ providers: { anthropic: { apiKey: "sk-file-1" } } }),
    })
    expect(result).toMatchObject({
      ok: true,
      credential: { secret: "sk-file-1", source: "profile:anthropic" },
    })
  })

  it("falls back to an authToken entry (subscription auth)", () => {
    const result = resolveCredential({
      ref: { credentialProfileRef: "anthropic" },
      home: HOME,
      env: {},
      readFile: fileWith({ providers: { anthropic: { authToken: "oauth-1" } } }),
    })
    expect(result.ok && result.credential.secret).toBe("oauth-1")
  })

  it("names the profiles that DO exist when the named one does not", () => {
    const result = resolveCredential({
      ref: { credentialProfileRef: "openai" },
      home: HOME,
      env: {},
      readFile: fileWith({ providers: { anthropic: { apiKey: "k" } } }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("openai")
    expect(result.error.detail).toMatchObject({ known: ["anthropic"] })
  })

  it("reports a missing credentials file by path", () => {
    const result = resolveCredential({
      ref: { credentialProfileRef: "anthropic" },
      home: HOME,
      env: {},
      readFile: () => null,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain(CREDENTIALS)
  })

  it("reports malformed JSON distinctly from a malformed shape", () => {
    const bad = resolveCredential({
      ref: { credentialProfileRef: "anthropic" },
      home: HOME,
      env: {},
      readFile: () => "{not json",
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.message).toContain("not valid JSON")

    const wrongShape = resolveCredential({
      ref: { credentialProfileRef: "anthropic" },
      home: HOME,
      env: {},
      // Reuses the CLI schema: an entry with neither apiKey nor authToken is
      // rejected there, so the SDK cannot disagree about what is valid.
      readFile: fileWith({ providers: { anthropic: {} } }),
    })
    expect(wrongShape.ok).toBe(false)
    if (!wrongShape.ok) expect(wrongShape.error.message).toContain("expected shape")
  })

  it("handles a credentials file with no providers block at all", () => {
    const result = resolveCredential({
      ref: { credentialProfileRef: "anthropic" },
      home: HOME,
      env: {},
      readFile: fileWith({}),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toMatchObject({ known: [] })
  })

  it("rejects an empty or whitespace-only profile reference", () => {
    const result = resolveCredential({
      ref: { credentialProfileRef: "  " },
      home: HOME,
      env: {},
      readFile: () => null,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain("credentialProfileRef or credentialEnv")
  })

  it("refuses an inlined secret before it ever reads a file", () => {
    const readFile = jest.fn(() => null)
    const result = resolveCredential({
      ref: { apiKey: "sk-inline" } as never,
      home: HOME,
      env: {},
      readFile,
    })
    expect(result.ok).toBe(false)
    expect(readFile).not.toHaveBeenCalled()
  })
})

// The injected `readFile` above is what makes these tests fast and hermetic,
// but it also means the DEFAULT reader — the one every real caller uses — is
// never exercised. These two cover it against a real temp home.
describe("resolveCredential — real filesystem", () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sdk-creds-"))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("reads credentials.json off disk when no reader is injected", () => {
    fs.writeFileSync(
      path.join(home, "credentials.json"),
      JSON.stringify({ providers: { anthropic: { apiKey: "sk-on-disk" } } })
    )
    const result = resolveCredential({ ref: { credentialProfileRef: "anthropic" }, home, env: {} })
    expect(result.ok && result.credential.secret).toBe("sk-on-disk")
  })

  it("treats an unreadable path as absent rather than throwing", () => {
    const result = resolveCredential({ ref: { credentialProfileRef: "anthropic" }, home, env: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("config_error")
  })
})
