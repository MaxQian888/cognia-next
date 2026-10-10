import sessionActionTable from "@/crates/cognia-collab-server/fixtures/session-actions.json"

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

describe("the shared action table", () => {
  // `crates/cognia-collab-server/fixtures/session-actions.json` is the table
  // the server's `authorize_session_action` is tested against too.
  const table: {
    actions: string[]
    roles: Record<string, string[]>
    guestDenied: string[]
    approverOverlay: { roles: string[]; actions: string[] }
  } = sessionActionTable
  const roles = ["owner", "maintainer", "member", "viewer"] as const

  it.each(roles)("decides every action for a %s as the server does", (role) => {
    for (const guest of [false, true]) {
      for (const approver of [false, true]) {
        for (const action of table.actions) {
          const expected =
            !(guest && table.guestDenied.includes(action)) &&
            (table.roles[role].includes(action) ||
              (approver &&
                table.approverOverlay.roles.includes(role) &&
                table.approverOverlay.actions.includes(action)))
          expect([
            role,
            guest,
            approver,
            action,
            authorizeSessionAction({ role, guest, approver }, action as never, 1).allowed,
          ]).toEqual([role, guest, approver, action, expected])
        }
      }
    }
  })
})
