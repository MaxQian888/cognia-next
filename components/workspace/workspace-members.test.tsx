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
import { WorkspaceMembers } from "./workspace-members"

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
