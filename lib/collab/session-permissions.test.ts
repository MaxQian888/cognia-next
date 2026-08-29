import { authorizeSessionAction } from "./session-permissions"

describe("authorizeSessionAction", () => {
  const member = { role: "member" as const, approver: false, guest: false }

  it("keeps a private session undiscoverable without explicit membership", () => {
    expect(authorizeSessionAction(null, "session.discover", 7)).toEqual({
      allowed: false,
      reason: "not_a_session_member",
      policyRevision: 7,
    })
  })

  it("allows members to post but not manage membership", () => {
    expect(authorizeSessionAction(member, "session.post", 3).allowed).toBe(true)
    expect(authorizeSessionAction(member, "session.manageMembers", 3).allowed).toBe(false)
  })

  it("allows an explicit approver to approve high-risk work", () => {
    expect(
      authorizeSessionAction({ ...member, approver: true }, "run.approveHighRisk", 4)
    ).toMatchObject({ allowed: true, reason: "explicit_approver" })
  })

  it("enforces the guest ceiling even when a role would otherwise allow the action", () => {
    expect(
      authorizeSessionAction(
        { role: "maintainer", approver: true, guest: true },
        "session.manageMembers",
        9
      )
    ).toEqual({ allowed: false, reason: "guest_capability_ceiling", policyRevision: 9 })
  })
})
