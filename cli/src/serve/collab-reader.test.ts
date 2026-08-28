import type { LogtoSession } from "@/lib/logto/client"

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
    accountId: "acct-1",
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
    accountId: "acct-1",
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
