import { LogtoRefreshError, type LogtoSession } from "@/lib/logto/client"

import type { LogtoSessionFs } from "../config/logto-session"
import { createCollabCursorStorage, startHeadlessCollabReader } from "./collab-reader"

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

it("binds the server identity and hands its own credentials to the registered runtimes", async () => {
  const bind = jest.fn().mockResolvedValue({})
  const session = sessionFs({
    issuer: "https://issuer.test/oidc",
    clientId: "brain",
    resource: "collab",
    accessToken: sessionToken("logto-subject"),
    scopes: [],
  })
  const reader = await startHeadlessCollabReader({
    localAccountId: "acct-1",
    cliHome: "/home",
    config: { url: "https://collab.test", orgId: ORG },
    deps: {
      sessionFs: session,
      fetchImpl,
      registry: { bind, get: jest.fn().mockResolvedValue({ orgId: ORG }) } as never,
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
  const resolved = await reader.runtime!.resolve("acct-1")
  expect(resolved?.orgId).toBe(ORG)
  expect(resolved?.client.baseUrl).toBe("https://collab.test")
  expect(await reader.runtime!.resolve("another-account")).toBeNull()
  session.remove("/home/logto.json")
  expect(await reader.runtime!.resolve("acct-1")).toBeNull()
  reader.stop()
})

describe("durable collaboration notification cursors", () => {
  function files() {
    const values = new Map<string, string>()
    return {
      values,
      fs: {
        readFile: (file: string) => values.get(file) ?? null,
        writeFileAtomic: (file: string, value: string) => {
          values.set(file, value)
        },
      },
    }
  }

  it("survives adapter recreation and isolates profiles", () => {
    const { fs } = files()
    const first = createCollabCursorStorage("/home", "acct-1", fs)
    first.setItem("scope", JSON.stringify({ cursor: { afterSeq: 7 }, pendingReadIds: ["n1"] }))
    const reopened = createCollabCursorStorage("/home", "acct-1", fs)
    expect(reopened.getItem("scope")).toBe(first.getItem("scope"))
    expect(createCollabCursorStorage("/home", "acct-2", fs).getItem("scope")).toBeNull()
    reopened.removeItem("scope")
    expect(first.getItem("scope")).toBeNull()
  })

  it.each(["{broken", "[]", '{"scope":123}'])("recovers %s as a quiet first pull", (raw) => {
    const { fs, values } = files()
    values.set("/home/collab-notifications/acct-1.json", raw)
    const local = createCollabCursorStorage("/home", "acct-1", fs)
    expect(local.getItem("scope")).toBeNull()
    local.setItem("scope", "recovered")
    expect(local.getItem("scope")).toBe("recovered")
  })
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
