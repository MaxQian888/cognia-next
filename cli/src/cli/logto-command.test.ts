/**
 * @jest-environment node
 */
import type { LogtoClientConfig, LogtoDrivers, LogtoSession } from "@/lib/logto/client"

import type { LogtoSessionFs } from "../config/logto-session"

import path from "node:path"

import { parseArgv } from "./args"
import { logtoCommand } from "./logto-command"

function captureOut() {
  const lines: string[] = []
  const errs: string[] = []
  return {
    sink: {
      write: (s: string) => lines.push(s),
      error: (s: string) => errs.push(s),
      json: (obj: unknown) => lines.push(JSON.stringify(obj) + "\n"),
    },
    text: () => lines.join(""),
    errText: () => errs.join(""),
  }
}

function memFs(seed?: Record<string, string>): LogtoSessionFs & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    store,
    read: (p) => store.get(p) ?? null,
    write: (p, c) => {
      store.set(p, c)
    },
    remove: (p) => {
      store.delete(p)
    },
    mkdirp: () => {},
  }
}

function fakeServer() {
  return {
    redirectUrl: "http://127.0.0.1:9321/callback",
    waitForCode: jest.fn(async () => ({ code: "the-code", state: "st" })),
    close: jest.fn(),
  }
}

const HOME = "/home/u/.cognia"
// Build the expected path the same way the source does (path.join), so the
// store key matches on both POSIX and Windows separators.
const SESSION_FILE = path.join(HOME, "logto.json")
const sampleSession: LogtoSession = {
  issuer: "https://logto.test/oidc",
  clientId: "cli-1",
  resource: "https://brain.test/api",
  organizationId: "org_9",
  accessToken: "ATK-secret-xyz",
  refreshToken: "RTK-secret-xyz",
  expiresAt: 1893456000000,
  scopes: ["brain:rpc"],
}

describe("logtoCommand", () => {
  it("login: runs the PKCE flow with flag config and persists the session", async () => {
    const cap = captureOut()
    const fs = memFs()
    const server = fakeServer()
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(
      async () => sampleSession
    )
    const openBrowser = jest.fn(async () => true)

    const code = await logtoCommand(
      parseArgv([
        "logto",
        "login",
        "--issuer",
        "https://logto.test/oidc",
        "--client-id",
        "cli-1",
        "--resource",
        "https://brain.test/api",
        "--scope",
        "brain:rpc,brain:read",
        "--org",
        "org_9",
      ]),
      {
        home: HOME,
        out: cap.sink,
        sessionFs: fs,
        login,
        startCallbackServer: async () => server as never,
        openBrowser,
        env: {},
      }
    )

    expect(code).toBe(0)
    const [cfg, drivers] = login.mock.calls[0]
    expect(cfg).toMatchObject({
      issuer: "https://logto.test/oidc",
      clientId: "cli-1",
      resource: "https://brain.test/api",
      organizationId: "org_9",
      redirectUri: "http://127.0.0.1:9321/callback",
    })
    expect(cfg.scopes).toEqual(["brain:rpc", "brain:read"])
    expect(JSON.parse(fs.store.get(SESSION_FILE)!)).toEqual(sampleSession)
    expect(server.close).toHaveBeenCalled()
    await expect(drivers.waitForCode({ redirectUri: "x", state: "st" })).resolves.toEqual({
      code: "the-code",
      state: "st",
    })
  })

  it("login: reads config from env when flags are absent", async () => {
    const cap = captureOut()
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(
      async () => sampleSession
    )
    const code = await logtoCommand(parseArgv(["logto", "login"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs(),
      login,
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {
        COGNIA_LOGTO_ISSUER: "https://logto.test/oidc",
        COGNIA_LOGTO_CLIENT_ID: "cli-1",
        COGNIA_LOGTO_AUDIENCE: "https://brain.test/api",
      },
    })
    expect(code).toBe(0)
    expect(login.mock.calls[0][0]).toMatchObject({
      issuer: "https://logto.test/oidc",
      clientId: "cli-1",
      resource: "https://brain.test/api",
    })
  })

  it("login: exits 2 when required config is missing", async () => {
    const cap = captureOut()
    const code = await logtoCommand(parseArgv(["logto", "login"]), {
      home: HOME,
      out: cap.sink,
      env: {},
    })
    expect(code).toBe(2)
    expect(cap.errText()).toMatch(/--issuer/)
  })

  it("login: exits 1 and closes the server when the flow throws", async () => {
    const cap = captureOut()
    const server = fakeServer()
    const login = jest.fn(async () => {
      throw new Error("boom")
    })
    const code = await logtoCommand(
      parseArgv(["logto", "login", "--issuer", "i", "--client-id", "c", "--resource", "r"]),
      {
        home: HOME,
        out: cap.sink,
        sessionFs: memFs(),
        login,
        startCallbackServer: async () => server as never,
        openBrowser: async () => true,
        env: {},
      }
    )
    expect(code).toBe(1)
    expect(cap.errText()).toMatch(/boom/)
    expect(server.close).toHaveBeenCalled()
  })

  it("login: prints the URL as a fallback when the browser cannot open", async () => {
    const cap = captureOut()
    const login = jest.fn(
      async (_cfg: unknown, drivers: { openUrl: (u: string) => Promise<void> | void }) => {
        await drivers.openUrl("https://logto.test/oidc/auth?x=1")
        return sampleSession
      }
    )
    await logtoCommand(
      parseArgv(["logto", "login", "--issuer", "i", "--client-id", "c", "--resource", "r"]),
      {
        home: HOME,
        out: cap.sink,
        sessionFs: memFs(),
        login,
        startCallbackServer: async () => fakeServer() as never,
        openBrowser: async () => false,
        env: {},
      }
    )
    expect(cap.text()).toMatch(/logto\.test\/oidc\/auth/)
  })

  it("status: prints the session summary without leaking tokens", async () => {
    const cap = captureOut()
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const code = await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
    })
    expect(code).toBe(0)
    expect(cap.text()).toMatch(/https:\/\/brain\.test\/api/)
    expect(cap.text()).toMatch(/org_9/)
    expect(cap.text()).not.toContain("ATK-secret-xyz")
    expect(cap.text()).not.toContain("RTK-secret-xyz")
  })

  it("status: reports not-signed-in when there is no session", async () => {
    const cap = captureOut()
    const code = await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs(),
      env: {},
    })
    expect(code).toBe(0)
    expect(cap.text()).toMatch(/not signed in/i)
  })

  it("logout: removes the session file", async () => {
    const cap = captureOut()
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const code = await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
    })
    expect(code).toBe(0)
    expect(fs.store.has(SESSION_FILE)).toBe(false)
  })

  it("errors on an unknown subcommand", async () => {
    const cap = captureOut()
    const code = await logtoCommand(parseArgv(["logto", "frobnicate"]), {
      home: HOME,
      out: cap.sink,
      env: {},
    })
    expect(code).toBe(2)
    expect(cap.errText()).toMatch(/login \| status \| logout/)
  })
})
