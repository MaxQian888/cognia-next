/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    t.has = () => true
    return t
  },
}))

import { WorkspaceInviteDialog, type WorkspaceInviteDialogProps } from "./workspace-invite-dialog"

function adminStub(overrides: Partial<WorkspaceInviteDialogProps["admin"]> = {}) {
  return {
    canManageOrg: false,
    canManageWorkspace: true,
    busy: false,
    inviteToWorkspace: jest.fn(async () => ({
      id: "inv_1",
      orgId: "org_acme",
      workspaceId: "proj_1",
      workspaceRole: "member" as const,
      createdBy: "usr_ada",
      expiresAt: Date.UTC(2030, 0, 1),
      createdAt: 1,
      token: "one-time-token",
    })),
    inviteToOrg: jest.fn(async () => {
      throw new Error("not in this test")
    }),
    ...overrides,
  }
}

describe("WorkspaceInviteDialog", () => {
  it("requires a reason before it will mint anything", async () => {
    const admin = adminStub()
    render(<WorkspaceInviteDialog open onOpenChange={() => {}} admin={admin} />)
    fireEvent.click(screen.getByTestId("workspace-invite-submit"))
    expect(await screen.findByTestId("workspace-invite-error")).toHaveTextContent("reasonRequired")
    expect(admin.inviteToWorkspace).not.toHaveBeenCalled()
  })

  /**
   * The token is shown once, from the create response, and never stored. The
   * dialog is the only place it ever appears.
   */
  it("mints a workspace invitation and shows the token once", async () => {
    const admin = adminStub()
    render(<WorkspaceInviteDialog open onOpenChange={() => {}} admin={admin} />)
    fireEvent.change(screen.getByTestId("workspace-invite-reason"), {
      target: { value: "  onboarding  " },
    })
    fireEvent.click(screen.getByTestId("workspace-invite-submit"))
    expect(await screen.findByTestId("workspace-invite-token")).toHaveTextContent("one-time-token")
    expect(admin.inviteToWorkspace).toHaveBeenCalledWith({
      role: "member",
      reason: "onboarding",
      expiresInDays: 7,
    })
  })

  it("offers the org scope only to somebody who may manage the org", () => {
    const { rerender } = render(
      <WorkspaceInviteDialog open onOpenChange={() => {}} admin={adminStub()} />
    )
    expect(screen.queryByTestId("workspace-invite-scope")).not.toBeInTheDocument()
    rerender(
      <WorkspaceInviteDialog
        open
        onOpenChange={() => {}}
        admin={adminStub({ canManageOrg: true })}
      />
    )
    expect(screen.getByTestId("workspace-invite-scope")).toBeInTheDocument()
  })

  /** An org invitation is a different server call with a different role set. */
  it("mints an org invitation when the org scope is chosen", async () => {
    const onIssued = jest.fn()
    const admin = adminStub({
      canManageOrg: true,
      inviteToOrg: jest.fn(async () => ({
        id: "inv_2",
        orgId: "org_acme",
        orgRole: "member" as const,
        createdBy: "usr_ada",
        expiresAt: Date.UTC(2030, 0, 1),
        createdAt: 1,
        token: "org-token",
      })),
    })
    render(<WorkspaceInviteDialog open onOpenChange={() => {}} admin={admin} onIssued={onIssued} />)
    fireEvent.click(screen.getByTestId("workspace-invite-scope-org"))
    expect(screen.getByTestId("workspace-invite-scope-org")).toHaveAttribute("aria-pressed", "true")
    fireEvent.change(screen.getByTestId("workspace-invite-reason"), { target: { value: "hire" } })
    fireEvent.click(screen.getByTestId("workspace-invite-submit"))
    expect(await screen.findByTestId("workspace-invite-token")).toHaveTextContent("org-token")
    expect(admin.inviteToOrg).toHaveBeenCalledWith({
      role: "member",
      reason: "hire",
      expiresInDays: 7,
    })
    expect(admin.inviteToWorkspace).not.toHaveBeenCalled()
    expect(onIssued).toHaveBeenCalledWith(expect.objectContaining({ id: "inv_2" }))
  })

  it("copies the token and reports the copy, and Done closes the dialog", async () => {
    const writeText = jest.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const onOpenChange = jest.fn()
    const admin = adminStub()
    render(<WorkspaceInviteDialog open onOpenChange={onOpenChange} admin={admin} />)
    fireEvent.change(screen.getByTestId("workspace-invite-reason"), { target: { value: "r" } })
    fireEvent.click(screen.getByTestId("workspace-invite-submit"))
    await screen.findByTestId("workspace-invite-token")
    fireEvent.click(screen.getByTestId("workspace-invite-copy"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("one-time-token"))
    await waitFor(() =>
      expect(screen.getByTestId("workspace-invite-copy")).toHaveTextContent("copied")
    )
    fireEvent.click(screen.getByRole("button", { name: "done" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("Cancel closes without minting", () => {
    const onOpenChange = jest.fn()
    const admin = adminStub()
    render(<WorkspaceInviteDialog open onOpenChange={onOpenChange} admin={admin} />)
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(admin.inviteToWorkspace).not.toHaveBeenCalled()
  })

  it("shows the server's refusal instead of a token", async () => {
    const admin = adminStub({
      inviteToWorkspace: jest.fn(async () => {
        throw new Error("only a maintainer may invite")
      }),
    })
    render(<WorkspaceInviteDialog open onOpenChange={() => {}} admin={admin} />)
    fireEvent.change(screen.getByTestId("workspace-invite-reason"), { target: { value: "r" } })
    fireEvent.click(screen.getByTestId("workspace-invite-submit"))
    // The headline is translated. The server's sentence is its {message} value.
    expect(await screen.findByTestId("workspace-invite-error")).toHaveTextContent("errors.server")
    expect(screen.queryByTestId("workspace-invite-token")).not.toBeInTheDocument()
  })

  it("forgets the token when closed", async () => {
    const admin = adminStub()
    const { rerender } = render(
      <WorkspaceInviteDialog open onOpenChange={() => {}} admin={admin} />
    )
    fireEvent.change(screen.getByTestId("workspace-invite-reason"), { target: { value: "r" } })
    fireEvent.click(screen.getByTestId("workspace-invite-submit"))
    await screen.findByTestId("workspace-invite-token")
    rerender(<WorkspaceInviteDialog open={false} onOpenChange={() => {}} admin={admin} />)
    rerender(<WorkspaceInviteDialog open onOpenChange={() => {}} admin={admin} />)
    await waitFor(() =>
      expect(screen.queryByTestId("workspace-invite-token")).not.toBeInTheDocument()
    )
    expect(screen.getByTestId("workspace-invite-reason")).toHaveValue("")
  })

  it("keeps submit off while a write is in flight or the person may not invite", () => {
    const { rerender } = render(
      <WorkspaceInviteDialog open onOpenChange={() => {}} admin={adminStub({ busy: true })} />
    )
    expect(screen.getByTestId("workspace-invite-submit")).toBeDisabled()
    rerender(
      <WorkspaceInviteDialog
        open
        onOpenChange={() => {}}
        admin={adminStub({ canManageWorkspace: false })}
      />
    )
    expect(screen.getByTestId("workspace-invite-submit")).toBeDisabled()
  })
})

describe("invitationLink", () => {
  it("points at /invite with the token, on this origin", async () => {
    const { invitationLink } = await import("./workspace-invite-dialog")
    expect(invitationLink("a b")).toBe(`${window.location.origin}/invite?token=a%20b`)
  })
})
