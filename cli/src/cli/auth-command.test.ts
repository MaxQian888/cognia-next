/**
 * @jest-environment node
 */
import { authCommand } from "./auth-command"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (t) => stdout.push(t),
    error: (t) => stderr.push(t),
    json: () => undefined,
  }
  return { out, stdout: () => stdout.join(""), stderr: () => stderr.join("") }
}

describe("authCommand", () => {
  it("login stores a credential for the given provider", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/home/.cognia/credentials.json")
    const code = await authCommand(
      parseArgv(["auth", "login", "--provider", "openai", "--api-key", "sk"]),
      {
        out: s.out,
        home: "/home/.cognia",
        setCredential,
      }
    )
    expect(code).toBe(0)
    expect(setCredential).toHaveBeenCalledWith("/home/.cognia", "openai", "sk", undefined, {
      kind: "apiKey",
    })
    expect(s.stdout()).toMatch(/Saved api key for "openai"/)
  })

  it("login stores a subscription token with --subscription", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    const code = await authCommand(parseArgv(["auth", "login", "--subscription", "oauth-tok"]), {
      out: s.out,
      home: "/h",
      setCredential,
    })
    expect(code).toBe(0)
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "oauth-tok", undefined, {
      kind: "authToken",
    })
    expect(s.stdout()).toMatch(/Saved subscription token for "anthropic"/)
  })

  it("login falls back to CLAUDE_CODE_OAUTH_TOKEN env as a subscription token", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    await authCommand(parseArgv(["auth", "login"]), {
      out: s.out,
      home: "/h",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-env" },
      setCredential,
    })
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "oauth-env", undefined, {
      kind: "authToken",
    })
  })

  it("login defaults to the anthropic provider", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    await authCommand(parseArgv(["auth", "login", "--api-key", "sk"]), {
      out: s.out,
      home: "/h",
      setCredential,
    })
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "sk", undefined, {
      kind: "apiKey",
    })
  })

  it("login falls back to COGNIA_LOGIN_API_KEY env", async () => {
    const s = sink()
    const setCredential = jest.fn().mockReturnValue("/p")
    await authCommand(parseArgv(["auth", "login"]), {
      out: s.out,
      home: "/h",
      env: { COGNIA_LOGIN_API_KEY: "envkey" },
      setCredential,
    })
    expect(setCredential).toHaveBeenCalledWith("/h", "anthropic", "envkey", undefined, {
      kind: "apiKey",
    })
  })

  it("login without a key errors with exit 2", async () => {
    const s = sink()
    const code = await authCommand(parseArgv(["auth", "login"]), {
      out: s.out,
      home: "/h",
      env: {},
      setCredential: jest.fn(),
    })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/--api-key/)
  })

  it("status lists stored providers", async () => {
    const s = sink()
    const code = await authCommand(parseArgv(["auth", "status"]), {
      out: s.out,
      home: "/h",
      listCredentialProviders: () => ["anthropic", "openai"],
    })
    expect(code).toBe(0)
    expect(s.stdout()).toMatch(/anthropic, openai/)
  })

  it("status reports when empty", async () => {
    const s = sink()
    await authCommand(parseArgv(["auth", "status"]), {
      out: s.out,
      home: "/h",
      listCredentialProviders: () => [],
    })
    expect(s.stdout()).toMatch(/No stored credentials/)
  })

  it("logout removes the provider credential", async () => {
    const s = sink()
    const deleteCredential = jest.fn()
    const code = await authCommand(parseArgv(["auth", "logout", "--provider", "openai"]), {
      out: s.out,
      home: "/h",
      deleteCredential,
    })
    expect(code).toBe(0)
    expect(deleteCredential).toHaveBeenCalledWith("/h", "openai")
  })

  it("errors with exit 2 on an unknown subcommand", async () => {
    const s = sink()
    const code = await authCommand(parseArgv(["auth"]), { out: s.out, home: "/h" })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/login \| status \| logout/)
  })
})
