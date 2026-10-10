import { CollabError } from "./client"
import {
  endCollabFileHost,
  ensureCollabFileHost,
  registrationMatches,
  type CollabFileHostDeps,
} from "./file-host"
import type { CurrentCollabContext } from "./runtime-client"
import type { CollabHostStatus } from "@/types/filespace/live"

const session = {
  id: "local-1",
  collaboration: {
    endpoint: "https://collab.test",
    orgId: "org_1",
    workspaceId: "ws_1",
    sessionId: "ses_1",
    policyRevision: 1,
    syncCursor: 0,
  },
}

function status(overrides: Partial<CollabHostStatus> = {}): CollabHostStatus {
  return {
    sessionId: "local-1",
    registration: {
      sessionId: "local-1",
      orgId: "org_1",
      collabSessionId: "ses_1",
      serverUrl: "https://collab.test",
      hostLabel: "Mac",
      registeredAt: 1,
      updatedAt: 1,
    },
    tokenPresent: true,
    running: true,
    lastContactAt: 2,
    lastError: null,
    unmirroredGrants: 0,
    ...overrides,
  }
}

function deps(current: CollabHostStatus, register: jest.Mock = jest.fn()) {
  const context = {
    localAccountId: "acct",
    orgId: "org_1",
    userId: "usr_a",
    client: { baseUrl: "https://collab.test/", registerFileHost: register },
  } as unknown as CurrentCollabContext
  const made: CollabFileHostDeps & { getStatus: jest.Mock; setHost: jest.Mock } = {
    resolveContext: jest.fn(async () => context),
    getStatus: jest.fn(async () => current),
    setHost: jest.fn(async () => status()),
  }
  return made
}

describe("registrationMatches", () => {
  it("accepts only a usable registration for the same counterpart and server", () => {
    expect(registrationMatches(status(), session, "https://collab.test/")).toBe(true)
    expect(registrationMatches(status({ tokenPresent: false }), session)).toBe(false)
    expect(registrationMatches(status({ registration: null }), session)).toBe(false)
    expect(registrationMatches(status({ lastError: "host_unregistered" }), session)).toBe(false)
    expect(registrationMatches(status(), session, "https://other.test")).toBe(false)
    expect(
      registrationMatches(status(), {
        ...session,
        collaboration: { ...session.collaboration, sessionId: "ses_2" },
      })
    ).toBe(false)
    expect(registrationMatches(status(), { id: "local-1" })).toBe(false)
  })
})

describe("ensureCollabFileHost", () => {
  it("reuses a registration that already serves the conversation", async () => {
    const register = jest.fn()
    const d = deps(status(), register)
    await expect(ensureCollabFileHost(session, "Mac", undefined, d)).resolves.toMatchObject({
      running: true,
    })
    expect(register).not.toHaveBeenCalled()
    expect(d.setHost).not.toHaveBeenCalled()
  })

  it("registers with the person's sign-in and hands the host only the token", async () => {
    const register = jest.fn(async () => ({ hostToken: "fht_new", host: { registered: true } }))
    const d = deps(status({ registration: null, tokenPresent: false }), register)
    const target = { hostId: "host-a" }
    await ensureCollabFileHost(session, "Studio Mac", target, d)
    expect(register).toHaveBeenCalledWith("org_1", "ses_1", "Studio Mac")
    expect(d.getStatus).toHaveBeenCalledWith("local-1", target)
    expect(d.setHost).toHaveBeenCalledWith(
      "local-1",
      {
        orgId: "org_1",
        collabSessionId: "ses_1",
        serverUrl: "https://collab.test/",
        hostLabel: "Studio Mac",
        hostToken: "fht_new",
      },
      target
    )
  })

  it("names a refusal by the server's answer", async () => {
    const forbidden = jest.fn(async () => {
      throw new CollabError(403, "forbidden")
    })
    await expect(
      ensureCollabFileHost(
        session,
        "Mac",
        undefined,
        deps(status({ registration: null }), forbidden)
      )
    ).rejects.toMatchObject({ code: "shared_session_forbidden" })
    const down = jest.fn(async () => {
      throw new CollabError(503, "down")
    })
    await expect(
      ensureCollabFileHost(session, "Mac", undefined, deps(status({ registration: null }), down))
    ).rejects.toMatchObject({ code: "shared_session_unavailable" })
  })

  it("refuses when the signed-in org is not the conversation's", async () => {
    const d = deps(status())
    d.resolveContext = jest.fn(async () => null)
    await expect(ensureCollabFileHost(session, "Mac", undefined, d)).rejects.toMatchObject({
      code: "shared_session_unavailable",
    })
    await expect(
      ensureCollabFileHost({ id: "local-2" }, "Mac", undefined, deps(status()))
    ).rejects.toMatchObject({ code: "shared_session_unavailable" })
  })
})

describe("endCollabFileHost", () => {
  it("asks the host to unregister itself", async () => {
    const d = deps(status())
    await endCollabFileHost(session, { hostId: "host-a" }, d)
    expect(d.setHost).toHaveBeenCalledWith("local-1", null, { hostId: "host-a" })
  })
})
