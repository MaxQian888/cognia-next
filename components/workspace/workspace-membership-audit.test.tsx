/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

// Keys the catalogue does not have, so the fallback path can be exercised.
const mockMissingKeys = new Set<string>([
  "audit.actions.workspaceMemberTeleported",
  "role.overlord",
])

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = (key: string) => !mockMissingKeys.has(key)
    return t
  },
  useFormatter: () => ({
    dateTime: (date: Date, options?: Intl.DateTimeFormatOptions) =>
      `date(${date.getTime()},${options?.dateStyle},${options?.timeStyle})`,
  }),
}))

import enWorkspace from "@/i18n/messages/en/workspace.json"
import zhWorkspace from "@/i18n/messages/zh-CN/workspace.json"
import { CollabError, type CollabMembershipAuditEvent } from "@/lib/collab/client"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"

import {
  MEMBERSHIP_AUDIT_ACTIONS,
  WorkspaceMembershipAudit,
  auditActionKey,
} from "./workspace-membership-audit"

function event(overrides: Partial<CollabMembershipAuditEvent> = {}): CollabMembershipAuditEvent {
  return {
    id: "aud_1",
    orgId: "org_acme",
    actorUserId: "usr_ada",
    targetUserId: "usr_cleo",
    workspaceId: "proj_1",
    action: "workspace.member.changed",
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
    // The headline is the translated action, never the server's dotted code.
    expect(row).toHaveTextContent("audit.actions.workspaceMemberChanged")
    expect(row).not.toHaveTextContent("workspace.member.changed")
    expect(row).toHaveTextContent("usr_cleo")
    // A workspace event carries workspace seats, in the reader's words.
    expect(row).toHaveTextContent("audit.roleChange(role.member,role.maintainer)")
    expect(row).toHaveTextContent("audit.detail(lead,audit.actor(usr_ada))")
    expect(row).toHaveTextContent("date(1,medium,short)")
  })

  it("labels an org event's roles as org roles", async () => {
    const list = jest.fn(async () => [
      event({ action: "org.member.changed", workspaceId: undefined, newRole: "admin" }),
    ])
    render(<WorkspaceMembershipAudit admin={adminWith(list)} />)
    fireEvent.click(screen.getByTestId("workspace-membership-audit-toggle"))
    const row = await screen.findByTestId("workspace-membership-audit-aud_1")
    expect(row).toHaveTextContent("audit.actions.orgMemberChanged")
    expect(row).toHaveTextContent("audit.roleChange(orgRole.member,orgRole.admin)")
  })

  it("shows a lone role without an arrow pointing from nothing", async () => {
    const list = jest.fn(async () => [
      event({
        action: "invitation.created",
        workspaceId: undefined,
        oldRole: undefined,
        newRole: "admin",
      }),
    ])
    render(<WorkspaceMembershipAudit admin={adminWith(list)} />)
    fireEvent.click(screen.getByTestId("workspace-membership-audit-toggle"))
    const row = await screen.findByTestId("workspace-membership-audit-aud_1")
    expect(row).toHaveTextContent("audit.actions.invitationCreated")
    expect(row).toHaveTextContent("orgRole.admin")
    expect(row).not.toHaveTextContent("audit.roleChange")
  })

  /**
   * A server newer than this client can record an action nobody translated yet.
   * The raw code is uglier than a label, and far better than a blank.
   */
  it("falls back to the raw action and role the catalogue does not know", async () => {
    const list = jest.fn(async () => [
      event({ action: "workspace.member.teleported", oldRole: "member", newRole: "overlord" }),
    ])
    render(<WorkspaceMembershipAudit admin={adminWith(list)} />)
    fireEvent.click(screen.getByTestId("workspace-membership-audit-toggle"))
    const row = await screen.findByTestId("workspace-membership-audit-aud_1")
    expect(row).toHaveTextContent("workspace.member.teleported")
    expect(row).toHaveTextContent("audit.roleChange(role.member,overlord)")
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

describe("auditActionKey", () => {
  it("flattens the server's dotted action into one message key", () => {
    expect(auditActionKey("org.member.changed")).toBe("orgMemberChanged")
    expect(auditActionKey("invitation.created")).toBe("invitationCreated")
    expect(auditActionKey("account.bootstrapped")).toBe("accountBootstrapped")
  })

  /**
   * `lint:i18n` only sees literal keys, so a dynamic `audit.actions.*` lookup
   * needs a test that walks the list. Without it an action the server writes
   * renders its raw code in one locale and nothing fails.
   */
  it("has a label in both locales for every action the server writes", () => {
    type Actions = { members: { audit: { actions: Record<string, string> } } }
    for (const action of MEMBERSHIP_AUDIT_ACTIONS) {
      const key = auditActionKey(action)
      expect((enWorkspace as Actions).members.audit.actions[key]).toBeTruthy()
      expect((zhWorkspace as Actions).members.audit.actions[key]).toBeTruthy()
    }
  })
})
