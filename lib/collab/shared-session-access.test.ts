import {
  assertLocalMutationAllowed,
  assertSharedSessionExport,
  assertSharedSessionRead,
} from "./shared-session-access"

const binding = {
  orgId: "org",
  workspaceId: "workspace",
  sessionId: "shared",
  policyRevision: 1,
  syncCursor: 0,
}

it("keeps legacy sessions local and private without a network dependency", async () => {
  const resolve = jest.fn()
  await expect(assertSharedSessionRead({}, resolve)).resolves.toBeUndefined()
  await expect(assertSharedSessionExport({}, resolve)).resolves.toBeUndefined()
  expect(resolve).not.toHaveBeenCalled()
})

it("uses authoritative export authorization and fails closed on denial or disconnection", async () => {
  const client = {
    baseUrl: "https://collab.example",
    authorizeSessionExport: jest.fn().mockResolvedValue(undefined),
  }
  const context = { orgId: "org", userId: "user", localAccountId: "local", client }
  const resolve = async () => context as never
  await expect(
    assertSharedSessionExport({ collaboration: binding }, resolve)
  ).resolves.toBeUndefined()
  expect(client.authorizeSessionExport).toHaveBeenCalledWith("org", "shared")
  client.authorizeSessionExport.mockRejectedValue(new Error("forbidden"))
  await expect(assertSharedSessionExport({ collaboration: binding }, resolve)).rejects.toThrow(
    "SESSION_NOT_FOUND"
  )
  await expect(
    assertSharedSessionExport({ collaboration: binding }, async () => null)
  ).rejects.toThrow("SESSION_NOT_FOUND")
})

it.each(["localAccountId", "userId", "orgId", "endpoint", "disconnected"])(
  "rejects export completion after the current %s changes",
  async (field) => {
    const client = {
      baseUrl: "https://collab.example",
      authorizeSessionExport: jest.fn().mockResolvedValue(undefined),
    }
    const before = { orgId: "org", userId: "user", localAccountId: "local", client }
    const after =
      field === "disconnected"
        ? null
        : field === "endpoint"
          ? { ...before, client: { ...client, baseUrl: "https://other.example" } }
          : { ...before, [field]: "other" }
    const resolve = jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    await expect(assertSharedSessionExport({ collaboration: binding }, resolve)).rejects.toThrow(
      "SESSION_NOT_FOUND"
    )
  }
)

it("rejects export requests with an endpoint or organization mismatch before network access", async () => {
  const client = { baseUrl: "https://other.example", authorizeSessionExport: jest.fn() }
  for (const collaboration of [
    { ...binding, endpoint: "https://original.example" },
    { ...binding, orgId: "another-org" },
  ]) {
    await expect(
      assertSharedSessionExport(
        { collaboration },
        async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
      )
    ).rejects.toThrow("SESSION_NOT_FOUND")
  }
  expect(client.authorizeSessionExport).not.toHaveBeenCalled()
})

it("requires current explicit membership for a shared-session read", async () => {
  const client = {
    getSharedSession: jest.fn().mockResolvedValue({ policyRevision: 2 }),
    listSessionMembers: jest
      .fn()
      .mockResolvedValue([{ userId: "user", role: "viewer", approver: false, guest: false }]),
  }
  await expect(
    assertSharedSessionRead(
      { collaboration: binding },
      async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
    )
  ).resolves.toBeUndefined()
  client.listSessionMembers.mockResolvedValue([])
  await expect(
    assertSharedSessionRead(
      { collaboration: binding },
      async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
    )
  ).rejects.toThrow("SESSION_NOT_FOUND")
})

it("never lets a local companion or connector write bypass the shared server", () => {
  expect(() => assertLocalMutationAllowed({ collaboration: binding }, "session.post")).toThrow(
    "SHARED_SESSION_SERVER_REQUIRED"
  )
})

it("does not authorize an identically named session on another endpoint", async () => {
  const client = { baseUrl: "https://other.example", getSharedSession: jest.fn() }
  await expect(
    assertSharedSessionRead(
      { collaboration: { ...binding, endpoint: "https://original.example" } },
      async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
    )
  ).rejects.toThrow("SESSION_NOT_FOUND")
  expect(client.getSharedSession).not.toHaveBeenCalled()
})

it("hides missing identities and transient authorization failures", async () => {
  await expect(
    assertSharedSessionRead({ collaboration: binding }, async () => null)
  ).rejects.toThrow("SESSION_NOT_FOUND")
  const client = {
    getSharedSession: jest.fn().mockRejectedValue(new Error("offline")),
    listSessionMembers: jest.fn().mockResolvedValue([]),
  }
  await expect(
    assertSharedSessionRead(
      { collaboration: binding },
      async () => ({ orgId: "org", userId: "user", localAccountId: "local", client }) as never
    )
  ).rejects.toThrow("SESSION_NOT_FOUND")
  expect(() => assertLocalMutationAllowed({}, "session.post")).not.toThrow()
})
