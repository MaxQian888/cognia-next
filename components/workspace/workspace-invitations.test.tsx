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
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { CollabError, type CollabInvitation } from "@/lib/collab/client"

import { WorkspaceInvitations, invitationStatus } from "./workspace-invitations"

const NOW = 1_000_000

function invitation(overrides: Partial<CollabInvitation> = {}): CollabInvitation {
  return {
    id: "inv_1",
    orgId: "org_acme",
    workspaceId: "proj_1",
    workspaceRole: "member",
    createdBy: "usr_ada",
    expiresAt: NOW + 86_400_000,
    createdAt: NOW - 10,
    ...overrides,
  }
}

function adminStub(rows: CollabInvitation[] = [invitation()]) {
  return {
    status: "ready" as const,
    canManageWorkspace: true,
    busy: false,
    listInvitations: jest.fn(async () => rows),
    revokeInvitation: jest.fn(async (id: string) => invitation({ id, revokedAt: NOW })),
  }
}

describe("invitationStatus", () => {
  it("prefers the recorded facts over the clock", () => {
    expect(invitationStatus(invitation(), NOW)).toBe("pending")
    expect(invitationStatus(invitation({ expiresAt: NOW - 1 }), NOW)).toBe("expired")
    expect(invitationStatus(invitation({ revokedAt: 1, expiresAt: NOW - 1 }), NOW)).toBe("revoked")
    expect(invitationStatus(invitation({ redeemedAt: 1, revokedAt: 2 }), NOW)).toBe("redeemed")
  })
})

describe("WorkspaceInvitations", () => {
  it("renders nothing for somebody who may not manage the workspace", () => {
    const { container } = render(
      <WorkspaceInvitations admin={{ ...adminStub(), canManageWorkspace: false }} now={() => NOW} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  /** Invitations are not mirrored: nothing is fetched until the section opens. */
  it("loads from the server only once opened, and shows each invitation's standing", async () => {
    const admin = adminStub([
      invitation(),
      invitation({ id: "inv_2", orgRole: "admin", workspaceId: undefined, expiresAt: NOW - 1 }),
    ])
    render(<WorkspaceInvitations admin={admin} now={() => NOW} />)
    expect(admin.listInvitations).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("workspace-invitations-toggle"))
    expect(await screen.findByTestId("workspace-invitation-inv_1")).toHaveAttribute(
      "data-status",
      "pending"
    )
    expect(screen.getByTestId("workspace-invitation-inv_1")).toHaveTextContent(
      "invitations.scopeWorkspace(role.member)"
    )
    expect(screen.getByTestId("workspace-invitation-inv_2")).toHaveAttribute(
      "data-status",
      "expired"
    )
    expect(screen.getByTestId("workspace-invitation-inv_2")).toHaveTextContent(
      "invitations.scopeOrg(orgRole.admin)"
    )
    // Only a pending invitation can be pulled back.
    expect(screen.getByTestId("workspace-invitation-revoke-inv_1")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-invitation-revoke-inv_2")).not.toBeInTheDocument()
  })

  it("revokes with the roster reason and reloads", async () => {
    const admin = adminStub()
    render(<WorkspaceInvitations admin={admin} now={() => NOW} />)
    fireEvent.click(screen.getByTestId("workspace-invitations-toggle"))
    fireEvent.click(await screen.findByTestId("workspace-invitation-revoke-inv_1"))
    await waitFor(() =>
      expect(admin.revokeInvitation).toHaveBeenCalledWith("inv_1", "reason.invitationRevoked")
    )
    await waitFor(() => expect(admin.listInvitations).toHaveBeenCalledTimes(2))
    expect(toast.success).toHaveBeenCalledWith("toast.invitationRevoked")
  })

  it("reloads when the key changes, and says so when the server refuses", async () => {
    const admin = adminStub()
    const { rerender } = render(
      <WorkspaceInvitations admin={admin} now={() => NOW} reloadKey={0} />
    )
    fireEvent.click(screen.getByTestId("workspace-invitations-toggle"))
    await screen.findByTestId("workspace-invitation-inv_1")
    admin.listInvitations.mockRejectedValueOnce(new CollabError(403, "not yours"))
    rerender(<WorkspaceInvitations admin={admin} now={() => NOW} reloadKey={1} />)
    expect(await screen.findByTestId("workspace-invitations-error")).toHaveTextContent(
      "errors.forbidden"
    )
  })

  it("says when there is nothing", async () => {
    render(<WorkspaceInvitations admin={adminStub([])} now={() => NOW} />)
    fireEvent.click(screen.getByTestId("workspace-invitations-toggle"))
    expect(await screen.findByTestId("workspace-invitations-empty")).toBeInTheDocument()
  })
})
