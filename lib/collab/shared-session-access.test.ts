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
