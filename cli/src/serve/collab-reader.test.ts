import { LogtoRefreshError, type LogtoSession } from "@/lib/logto/client"

import type { LogtoSessionFs } from "../config/logto-session"
import { startHeadlessCollabReader } from "./collab-reader"

function sessionToken(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url")
  return `header.${payload}.signature`
}

function sessionFs(session: LogtoSession | null): LogtoSessionFs {
  let raw = session ? JSON.stringify(session) : null
  return {
    read: () => raw,
    write: (_path, content) => {
      raw = content
    },
    remove: () => {
      raw = null
    },
    mkdirp: () => undefined,
  }
}

const ORG = "org_acme00000000000000000"
const USER = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

function fetchImpl(url: string): Promise<Response> {
  if (url.endsWith("/grants")) {
    return Promise.resolve(
      Response.json({ grant: "grant", userId: USER, orgId: ORG, expiresAt: 10_000 })
    )
  }
  if (url.endsWith("/memberships/me")) {
    return Promise.resolve(Response.json({ userId: USER, orgRole: "owner", workspaces: [] }))
  }
  return Promise.resolve(Response.json([]))
}

it("stays inactive without the existing 0600 Logto session", async () => {
  const reader = await startHeadlessCollabReader({
    localAccountId: "acct-1",
    cliHome: "/home",
    config: { url: "https://collab.test", orgId: ORG },
    deps: { sessionFs: sessionFs(null) },
  })
  expect(reader.status).toBe("not-signed-in")
})

it("binds the server identity and installs read-only polling", async () => {
  const bind = jest.fn().mockResolvedValue({})
  const timeout = jest.fn().mockReturnValue({ unref: jest.fn() })
  const reader = await startHeadlessCollabReader({
    localAccountId: "acct-1",
    cliHome: "/home",
    config: { url: "https://collab.test", orgId: ORG },
    deps: {
      sessionFs: sessionFs({
        issuer: "https://issuer.test/oidc",
        clientId: "brain",
        resource: "collab",
        accessToken: sessionToken("logto-subject"),
        scopes: [],
      }),
      fetchImpl,
      registry: { bind, get: jest.fn().mockResolvedValue({ orgId: ORG }) } as never,
      setTimeout: timeout as never,
    },
  })
  expect(reader.status).toBe("active")
  expect(bind).toHaveBeenCalledWith(
    expect.objectContaining({
      localAccountId: "acct-1",
      userId: USER,
      orgId: ORG,
      logtoSubject: "logto-subject",
    })
  )
  expect(timeout).toHaveBeenCalled()
  reader.stop()
})

describe("a refresh that is refused vs one that merely failed", () => {
  const stale: LogtoSession = {
    issuer: "https://issuer.test/oidc",
    clientId: "brain",
    resource: "collab",
    accessToken: sessionToken("logto-subject"),
    refreshToken: "rt",
    expiresAt: 1,
    scopes: [],
  }

  it("removes the session file on invalid_grant, so no later poll presents a dead token", async () => {
    const fs = sessionFs(stale)
    const refreshToken = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", { oauthError: "invalid_grant" })
    })
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      deps: { sessionFs: fs, refreshToken, now: () => 10_000 },
    })
    expect(reader.status).toBe("not-signed-in")
    expect(fs.read("/home/logto.json")).toBeNull()
  })

  it("never treats an untyped throw as a revocation", async () => {
    const fs = sessionFs(stale)
    const refreshToken = jest.fn(async () => {
      throw new Error("something else")
    })
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      deps: { sessionFs: fs, refreshToken, now: () => 10_000 },
    })
    expect(reader.status).toBe("not-signed-in")
    expect(fs.read("/home/logto.json")).not.toBeNull()
  })

  it("keeps the file when the issuer was merely unreachable, and hands out no token", async () => {
    const fs = sessionFs(stale)
    const refreshToken = jest.fn(async () => {
      throw new LogtoRefreshError("network", "down")
    })
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      deps: { sessionFs: fs, refreshToken, now: () => 10_000 },
    })
    expect(reader.status).toBe("not-signed-in")
    expect(fs.read("/home/logto.json")).not.toBeNull()
  })
})
