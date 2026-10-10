import { SharedSessionAccessError } from "@/lib/collab/shared-session-access"
import type { CreatedLiveGrant, CreateLiveGrantRequest } from "@/types/filespace/live"

import { fileShareErrorDetails } from "./grants-client"
import { createLiveFileShare, type CreateLiveFileShareDeps } from "./live-share"

const request: CreateLiveGrantRequest = {
  sessionId: "s1",
  paths: ["/workspace/src"],
  permissions: ["read", "download"],
  protocols: ["webdav"],
  expiresInSeconds: 3600,
}

const created = { grant: { id: "fg_1" } } as unknown as CreatedLiveGrant

function deps(patch: Partial<CreateLiveFileShareDeps> = {}): CreateLiveFileShareDeps {
  return {
    getSession: jest.fn(async () => ({ id: "s1" })),
    authorizeSharedSession: jest.fn(async () => ({ orgId: "org_1", policyRevision: 3 })),
    ensureCollabFileHost: jest.fn(async () => ({}) as never),
    createLiveGrant: jest.fn(async () => created),
    ...patch,
  }
}

const shared = { id: "s1", collaboration: { orgId: "org_1", sessionId: "cs_1" } } as never

describe("createLiveFileShare", () => {
  it("creates a local conversation's grant without asking the plane", async () => {
    const d = deps()
    await expect(createLiveFileShare(request, { hostId: "local" }, d)).resolves.toBe(created)
    expect(d.authorizeSharedSession).not.toHaveBeenCalled()
    expect(d.createLiveGrant).toHaveBeenCalledWith(request, { hostId: "local" })
  })

  it("asks the plane first for a shared conversation", async () => {
    const d = deps({ getSession: jest.fn(async () => shared) })
    await createLiveFileShare(request, undefined, d)
    expect(d.authorizeSharedSession).toHaveBeenCalledWith(shared)
    expect(d.createLiveGrant).toHaveBeenCalled()
  })

  it("refuses with a code when the plane forbids it, and asks the host nothing", async () => {
    const d = deps({
      getSession: jest.fn(async () => shared),
      authorizeSharedSession: jest.fn(async () => {
        throw new SharedSessionAccessError("forbidden")
      }),
    })
    const error = await createLiveFileShare(request, undefined, d).catch((caught) => caught)
    expect(fileShareErrorDetails(error).code).toBe("shared_session_forbidden")
    expect(d.createLiveGrant).not.toHaveBeenCalled()
  })

  it("refuses as unavailable when the plane cannot answer", async () => {
    const d = deps({
      getSession: jest.fn(async () => shared),
      authorizeSharedSession: jest.fn(async () => {
        throw new SharedSessionAccessError("not_found")
      }),
    })
    const error = await createLiveFileShare(request, undefined, d).catch((caught) => caught)
    expect(fileShareErrorDetails(error).code).toBe("shared_session_unavailable")
    expect(d.createLiveGrant).not.toHaveBeenCalled()
  })

  it("registers the host before a share for the conversation's members", async () => {
    const order: string[] = []
    const d = deps({
      getSession: jest.fn(async () => shared),
      authorizeSharedSession: jest.fn(async () => {
        order.push("authorize")
        return { orgId: "org_1", policyRevision: 3 }
      }),
      ensureCollabFileHost: jest.fn(async () => {
        order.push("register")
        return {} as never
      }),
      createLiveGrant: jest.fn(async () => {
        order.push("create")
        return created
      }),
    })
    const members: CreateLiveGrantRequest = {
      ...request,
      protocols: [],
      audience: { kind: "collab", minRole: "viewer" },
    }
    await createLiveFileShare(members, { hostId: "host-a" }, d, { hostLabel: " Studio " })
    expect(order).toEqual(["authorize", "register", "create"])
    expect(d.ensureCollabFileHost).toHaveBeenCalledWith(shared, "Studio", { hostId: "host-a" })
    expect(d.createLiveGrant).toHaveBeenCalledWith(members, { hostId: "host-a" })
  })

  it("refuses a members' share of a conversation that has no members", async () => {
    const d = deps()
    const error = await createLiveFileShare(
      { ...request, protocols: [], audience: { kind: "collab", minRole: "member" } },
      undefined,
      d
    ).catch((caught) => caught)
    expect(fileShareErrorDetails(error).code).toBe("collab_host_unregistered")
    expect(d.ensureCollabFileHost).not.toHaveBeenCalled()
    expect(d.createLiveGrant).not.toHaveBeenCalled()
  })

  it("does not register for a credential share of a shared conversation", async () => {
    const d = deps({ getSession: jest.fn(async () => shared) })
    await createLiveFileShare(request, undefined, d)
    expect(d.ensureCollabFileHost).not.toHaveBeenCalled()
  })
})
