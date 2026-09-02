/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { CollabError } from "@/lib/collab/client"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    t.has = () => true
    return t
  },
}))

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { putOrgMembership, replaceWorkspaceRoster } from "@/lib/db/identity"
import type { CurrentCollabContext } from "@/lib/collab/runtime-client"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { WorkspaceMembers, initialsFor } from "./workspace-members"

const ORG = "org_acme"
const WORKSPACE = "proj_1"

describe("WorkspaceMembers", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("renders nothing at all without a workspace", () => {
    const { container } = render(<WorkspaceMembers workspaceId={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says a workspace nobody shares is empty, not broken", async () => {
    render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-members-empty")).toBeInTheDocument()
  })

  /**
   * The point of the whole surface: a guest is a person with workspace
   * membership and no org membership, and until the roster pull existed
   * nobody but the guest could see one.
   */
  it("marks the member who is not in the org as a guest", async () => {
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true },
        { userId: "usr_cleo", displayName: "Cleo", role: "viewer", orgMember: false },
      ],
      now: 1,
    })

    render(<WorkspaceMembers workspaceId={WORKSPACE} />)

    expect(await screen.findByTestId("workspace-member-usr_cleo")).toHaveTextContent("Cleo")
    expect(await screen.findByTestId("workspace-member-guest-usr_cleo")).toBeInTheDocument()
    // And the org member carries no guest badge.
    expect(screen.queryByTestId("workspace-member-guest-usr_ada")).not.toBeInTheDocument()
  })

  it("shows the raw id for somebody the projection has no name for", async () => {
    // An id you can search for beats "unknown person" — the same call the
    // device console and the Feishu principals card make.
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_nameless", displayName: "", role: "viewer", orgMember: true }],
      now: 1,
    })

    render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-member-usr_nameless")).toHaveTextContent(
      "usr_nameless"
    )
  })

  /**
   * The first name anybody looks for is their own. Without a marker the reader
   * has to scan for it.
   */
  it("marks the reader's own row", async () => {
    await new UserBindingRegistry().bind({
      localAccountId: getActiveAccountId(),
      userId: "usr_ada",
      logtoSubject: "sub_ada",
      logtoIssuer: "https://logto.example",
      now: 1,
    })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true },
        { userId: "usr_cleo", displayName: "Cleo", role: "viewer", orgMember: true },
      ],
      now: 1,
    })

    render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-member-self-usr_ada")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-member-self-usr_cleo")).not.toBeInTheDocument()
  })

  /**
   * The server owns membership and exactly one production writer touches these
   * rows. Hiding the control would collapse "not built", "not permitted" and
   * "not available here" into one silence.
   */
  it("offers invite as refused-with-a-reason rather than not at all", async () => {
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true }],
      now: 1,
    })

    render(
      <WorkspaceMembers
        workspaceId={WORKSPACE}
        adminDeps={{ resolveContext: async () => null, registry: { get: async () => null } }}
      />
    )
    const invite = await screen.findByTestId("workspace-members-invite")
    await waitFor(() => expect(invite).toHaveAttribute("data-unavailable", "true"))
    expect(invite).toBeDisabled()
    expect(invite).toHaveAttribute("title", "unavailable.not-signed-in")
    expect(screen.getByTestId("workspace-members-invite-reason")).toHaveTextContent(
      "unavailable.not-signed-in"
    )
    // A plain member on a configured plane is refused with a different reason.
    expect(screen.queryByTestId("workspace-member-role-usr_ada")).not.toBeInTheDocument()
  })

  function managerDeps(client: Record<string, jest.Mock>, refresh = jest.fn(async () => null)) {
    const context: CurrentCollabContext = {
      localAccountId: getActiveAccountId(),
      orgId: ORG,
      userId: "usr_ada",
      client: client as unknown as CurrentCollabContext["client"],
    }
    return {
      resolveContext: async () => context,
      registry: { get: async () => ({ userId: "usr_ada", orgId: ORG }) as never },
      refresh,
    }
  }

  /**
   * The controls belong to a maintainer. They never appear on the reader's
   * own row, and offboarding is an org power that needs an org seat to take.
   */
  it("gives a maintainer role, remove and offboard controls on everybody but themselves", async () => {
    await putOrgMembership({ orgId: ORG, userId: "usr_ada", role: "admin", now: 1 })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true },
        { userId: "usr_cleo", displayName: "Cleo", role: "member", orgMember: true },
        { userId: "usr_gus", displayName: "Gus", role: "viewer", orgMember: false },
      ],
      now: 1,
    })
    const client = {
      removeWorkspaceMember: jest.fn(async () => undefined),
      offboardOrgMember: jest.fn(async () => undefined),
      setWorkspaceMember: jest.fn(async () => undefined),
    }
    const refresh = jest.fn(async () => null)
    render(<WorkspaceMembers workspaceId={WORKSPACE} adminDeps={managerDeps(client, refresh)} />)

    expect(await screen.findByTestId("workspace-member-role-usr_cleo")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-member-role-usr_ada")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-member-offboard-usr_cleo")).toBeInTheDocument()
    // A guest holds no org seat, so there is nothing to offboard them from.
    expect(screen.queryByTestId("workspace-member-offboard-usr_gus")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-member-remove-usr_gus")).toBeInTheDocument()
    const invite = screen.getByTestId("workspace-members-invite")
    await waitFor(() => expect(invite).not.toBeDisabled())

    fireEvent.click(screen.getByTestId("workspace-member-remove-usr_cleo"))
    await waitFor(() =>
      expect(client.removeWorkspaceMember).toHaveBeenCalledWith(
        ORG,
        WORKSPACE,
        "usr_cleo",
        "reason.removed"
      )
    )
    expect(refresh).toHaveBeenCalledWith(getActiveAccountId())

    fireEvent.click(screen.getByTestId("workspace-member-offboard-usr_cleo"))
    await waitFor(() =>
      expect(client.offboardOrgMember).toHaveBeenCalledWith(ORG, "usr_cleo", "reason.offboarded")
    )
    expect(toast.success).toHaveBeenCalledWith("toast.offboarded")

    // The live sections and the dialog are mounted for a manager.
    expect(screen.getByTestId("workspace-invitations")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-membership-audit")).toBeInTheDocument()
    fireEvent.click(invite)
    expect(await screen.findByTestId("workspace-invite-dialog")).toBeInTheDocument()
  })

  it("changes a workspace seat and an org role through their selects", async () => {
    await putOrgMembership({ orgId: ORG, userId: "usr_ada", role: "owner", now: 1 })
    await putOrgMembership({ orgId: ORG, userId: "usr_cleo", role: "member", now: 1 })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true },
        { userId: "usr_cleo", displayName: "Cleo", role: "member", orgMember: true },
      ],
      now: 1,
    })
    const client = {
      setWorkspaceMember: jest.fn(async () => undefined),
      setOrgMemberRole: jest.fn(async () => undefined),
    }
    const user = userEvent.setup()
    render(<WorkspaceMembers workspaceId={WORKSPACE} adminDeps={managerDeps(client)} />)

    await user.click(await screen.findByTestId("workspace-member-role-usr_cleo"))
    await user.click(await screen.findByRole("option", { name: "role.viewer" }))
    await waitFor(() =>
      expect(client.setWorkspaceMember).toHaveBeenCalledWith(ORG, WORKSPACE, "usr_cleo", {
        role: "viewer",
        reason: "reason.roleChanged",
      })
    )

    const orgRole = await screen.findByTestId("workspace-member-org-role-usr_cleo")
    expect(orgRole).toHaveTextContent("orgRole.member")
    await user.click(orgRole)
    await user.click(await screen.findByRole("option", { name: "orgRole.admin" }))
    await waitFor(() =>
      expect(client.setOrgMemberRole).toHaveBeenCalledWith(ORG, "usr_cleo", {
        role: "admin",
        reason: "reason.orgRoleChanged",
      })
    )
    expect(toast.success).toHaveBeenCalledWith("toast.orgRoleChanged")
  })

  /**
   * The refusal the server gives is the useful fact. It reaches the toast as
   * the description under a translated headline, read from the thrown error,
   * never from a state value captured before the click.
   */
  it("shows the server's refusal in the toast", async () => {
    await putOrgMembership({ orgId: ORG, userId: "usr_ada", role: "admin", now: 1 })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true },
        { userId: "usr_cleo", displayName: "Cleo", role: "member", orgMember: true },
      ],
      now: 1,
    })
    const client = {
      removeWorkspaceMember: jest.fn(async () => {
        throw new CollabError(409, "owners cannot be removed")
      }),
    }
    render(<WorkspaceMembers workspaceId={WORKSPACE} adminDeps={managerDeps(client)} />)
    fireEvent.click(await screen.findByTestId("workspace-member-remove-usr_cleo"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("toast.failed", {
        description: "errors.server",
      })
    )
  })

  it("refuses a plain member with the permission reason and no controls", async () => {
    await putOrgMembership({ orgId: ORG, userId: "usr_ada", role: "member", now: 1 })
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [
        { userId: "usr_ada", displayName: "Ada", role: "member", orgMember: true },
        { userId: "usr_cleo", displayName: "Cleo", role: "member", orgMember: true },
      ],
      now: 1,
    })
    render(<WorkspaceMembers workspaceId={WORKSPACE} adminDeps={managerDeps({})} />)
    await screen.findByTestId("workspace-member-usr_cleo")
    const invite = screen.getByTestId("workspace-members-invite")
    await waitFor(() => expect(invite).toHaveAttribute("title", "unavailable.not-permitted"))
    expect(screen.queryByTestId("workspace-member-role-usr_cleo")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-member-remove-usr_cleo")).not.toBeInTheDocument()
  })

  /** A small roster does not need a filter, and a long one is unscannable without. */
  it("offers the role filter only once the roster stops being scannable", async () => {
    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: [{ userId: "usr_ada", displayName: "Ada", role: "maintainer", orgMember: true }],
      now: 1,
    })
    const { unmount } = render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    await screen.findByTestId("workspace-member-usr_ada")
    expect(screen.queryByTestId("workspace-members-role-filter")).not.toBeInTheDocument()
    unmount()

    await replaceWorkspaceRoster({
      workspaceId: WORKSPACE,
      orgId: ORG,
      members: Array.from({ length: 9 }, (_, i) => ({
        userId: `usr_${i}`,
        displayName: `Person ${i}`,
        role: "member" as const,
        orgMember: true,
      })),
      now: 2,
    })
    render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-members-role-filter")).toBeInTheDocument()
  })

  it("does not show another workspace's members", async () => {
    await replaceWorkspaceRoster({
      workspaceId: "proj_other",
      orgId: ORG,
      members: [{ userId: "usr_bob", displayName: "Bob", role: "member", orgMember: true }],
      now: 1,
    })

    render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-members-empty")).toBeInTheDocument()
  })
})

describe("initialsFor", () => {
  it("takes one letter from each of the first two words", () => {
    expect(
      initialsFor({
        membership: { id: "m", workspaceId: "w", userId: "usr_x", role: "member" } as never,
        user: { id: "usr_x", displayName: "Ada Lovelace" } as never,
        guest: false,
      })
    ).toBe("AL")
  })

  /**
   * The projection can hold a membership without the person, so the fallback
   * has to work on a raw id. The `usr_` prefix is on every one of them and
   * would make every avatar read "US".
   */
  it("falls back to the id with its prefix stripped", () => {
    expect(
      initialsFor({
        membership: { id: "m", workspaceId: "w", userId: "usr_cleo", role: "viewer" } as never,
        guest: true,
      })
    ).toBe("CL")
  })
})
