/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
}))

import { CollabError, type CollabMembershipAuditEvent } from "@/lib/collab/client"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"

import { WorkspaceMembershipAudit } from "./workspace-membership-audit"

function event(overrides: Partial<CollabMembershipAuditEvent> = {}): CollabMembershipAuditEvent {
  return {
    id: "aud_1",
    orgId: "org_acme",
    actorUserId: "usr_ada",
    targetUserId: "usr_cleo",
    action: "workspace.member.role",
    oldRole: "member",
    newRole: "maintainer",
    reason: "lead",
    requestId: "req_1",
    createdAt: 1,
    ...overrides,
  }
}

function adminWith(listAuthorizationAudit: jest.Mock, canManageOrg = true) {
  const context: CurrentCollabContext = {
    localAccountId: "acct_a",
    orgId: "org_acme",
    userId: "usr_ada",
    client: { listAuthorizationAudit } as unknown as CurrentCollabContext["client"],
  }
  return { status: "ready" as const, canManageOrg, context }
}

describe("WorkspaceMembershipAudit", () => {
  it("is for org managers only", () => {
    const { container } = render(
      <WorkspaceMembershipAudit
        admin={adminWith(
          jest.fn(async () => []),
          false
        )}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("reads the org audit on demand and shows who did what to whom, and why", async () => {
    const list = jest.fn(async () => [event()])
    render(<WorkspaceMembershipAudit admin={adminWith(list)} />)
    expect(list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("workspace-membership-audit-toggle"))
    const row = await screen.findByTestId("workspace-membership-audit-aud_1")
    expect(list).toHaveBeenCalledWith("org_acme", 50)
    expect(row).toHaveTextContent("workspace.member.role")
    expect(row).toHaveTextContent("usr_cleo")
    expect(row).toHaveTextContent("audit.roleChange(member,maintainer)")
    expect(row).toHaveTextContent("lead")
    expect(row).toHaveTextContent("audit.actor(usr_ada)")
  })

  it("reloads on the key and says when the server refuses", async () => {
    const list = jest.fn(async () => [event()])
    const admin = adminWith(list)
    const { rerender } = render(<WorkspaceMembershipAudit admin={admin} reloadKey={0} />)
    fireEvent.click(screen.getByTestId("workspace-membership-audit-toggle"))
    await screen.findByTestId("workspace-membership-audit-aud_1")
    list.mockRejectedValueOnce(new CollabError(500, "db down"))
    rerender(<WorkspaceMembershipAudit admin={admin} reloadKey={1} />)
    expect(await screen.findByTestId("workspace-membership-audit-error")).toHaveTextContent(
      "errors.server(db down)"
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it("says when nothing has been recorded", async () => {
    render(<WorkspaceMembershipAudit admin={adminWith(jest.fn(async () => []))} />)
    fireEvent.click(screen.getByTestId("workspace-membership-audit-toggle"))
    expect(await screen.findByTestId("workspace-membership-audit-empty")).toBeInTheDocument()
  })
})
