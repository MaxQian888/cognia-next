import { assertLocalMutationAllowed, assertSharedSessionRead } from "./shared-session-access"

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
  expect(resolve).not.toHaveBeenCalled()
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
