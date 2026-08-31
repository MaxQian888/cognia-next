/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    t.has = () => true
    return t
  },
}))

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { replaceWorkspaceRoster } from "@/lib/db/identity"
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

    render(<WorkspaceMembers workspaceId={WORKSPACE} />)
    const invite = await screen.findByTestId("workspace-members-invite")
    expect(invite).toBeDisabled()
    expect(invite).toHaveAttribute("title", "inviteUnavailable")
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
