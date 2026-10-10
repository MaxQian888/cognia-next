import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/filespace/grants-client", () => ({
  ...jest.requireActual("@/lib/filespace/grants-client"),
  suspendLiveGrant: jest.fn(async () => ({})),
  resumeLiveGrant: jest.fn(async () => ({})),
  revokeLiveGrant: jest.fn(async () => ({})),
  rotateLiveCredential: jest.fn(),
}))
// The audit trail has its own suite; this one pins what the list hands it.
const mockAudit = jest.fn()
jest.mock("./live-share-audit", () => ({
  LiveShareAudit: (props: Record<string, unknown>) => {
    mockAudit(props)
    return <div data-testid="audit" />
  },
}))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))

import { toast } from "sonner"
import {
  resumeLiveGrant,
  revokeLiveGrant,
  rotateLiveCredential,
  suspendLiveGrant,
} from "@/lib/filespace/grants-client"
import type { FileShareStatus, LiveEndpoints, LiveGrantView } from "@/types/filespace/live"

import { endpointsForProvider, LiveGrantsList } from "./live-grants-list"

const FUTURE = 4_000_000_000_000

function view(id: string, patch: Partial<LiveGrantView["grant"]> = {}): LiveGrantView {
  return {
    grant: {
      id,
      sessionId: "s1",
      label: `Share ${id}`,
      createdBy: "user",
      creatorPrincipal: "owner",
      audience: { kind: "credentials" },
      protocols: ["webdav"],
      provider: "builtin",
      permissions: ["read", "download"],
      status: "active",
      statusReason: null,
      expiresAt: FUTURE,
      policyRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      revokedAt: null,
      paths: [
        {
          mountId: "workspace",
          relPath: "src",
          isDir: true,
          mountFingerprint: "fp",
          virtualPath: "/workspace/src",
        },
      ],
      ...patch,
    },
    credentials: [
      {
        id: `fc_${id}`,
        grantId: id,
        protocol: "webdav",
        provider: "builtin",
        username: `cg_${id}`,
        sshKeyFingerprint: null,
        createdAt: 1,
        rotatedAt: null,
        revokedAt: null,
      },
    ],
  }
}

const listenerEndpoints: LiveEndpoints = {
  webdavUrls: ["http://127.0.0.1:27893/"],
  sftp: [],
  sftpHostKeyFingerprint: null,
  tlsFingerprint: null,
  unavailableReason: null,
}
const sftpgoEndpoints: LiveEndpoints = {
  ...listenerEndpoints,
  webdavUrls: ["https://files.example.com/dav/"],
}
const status = {
  listener: { endpoints: listenerEndpoints },
  sftpgo: { endpoints: sftpgoEndpoints },
} as unknown as FileShareStatus

function renderList(grants: LiveGrantView[], extra: { showConversation?: boolean } = {}) {
  const onChanged = jest.fn()
  render(
    <LiveGrantsList
      grants={grants}
      status={status}
      hostId="local"
      onChanged={onChanged}
      {...extra}
    />
  )
  return onChanged
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: `Actions for ${label}` }))
}

beforeEach(() => jest.clearAllMocks())

describe("endpointsForProvider", () => {
  it("reads the provider's own endpoints from the host status", () => {
    expect(endpointsForProvider(status, "builtin")).toBe(listenerEndpoints)
    expect(endpointsForProvider(status, "sftpgo")).toBe(sftpgoEndpoints)
    expect(endpointsForProvider(null, "builtin")).toBeNull()
  })
})

describe("LiveGrantsList", () => {
  it("marks a grant an agent made", () => {
    renderList([view("g1"), view("g2", { createdBy: "agent" })])
    expect(screen.queryByTestId("live-grant-by-agent-g1")).toBeNull()
    expect(screen.getByTestId("live-grant-by-agent-g2")).toHaveTextContent("By an agent")
  })

  it("says which members a members' share admits, and why one ended", () => {
    renderList([
      view("m1", {
        protocols: [],
        audience: {
          kind: "collab",
          orgId: "org_1",
          collabSessionId: "ses_1",
          userIds: null,
          minRole: "member",
        },
      }),
      view("m2", {
        protocols: [],
        audience: {
          kind: "collab",
          orgId: "org_1",
          collabSessionId: "ses_1",
          userIds: ["usr_a", "usr_b"],
          minRole: "viewer",
        },
        status: "revoked",
        statusReason: "collab_host_removed",
      }),
      view("c1"),
    ])
    expect(screen.getByTestId("live-grant-members-m1")).toHaveTextContent("Members · Member and up")
    expect(screen.getByTestId("live-grant-members-m2")).toHaveTextContent("2 chosen members")
    expect(
      within(screen.getByTestId("live-grant-m2")).getByTestId("live-grant-reason")
    ).toHaveTextContent("This device stopped serving the shared conversation's files")
    expect(screen.queryByTestId("live-grant-members-c1")).toBeNull()
  })

  it("says when nothing is shared", () => {
    renderList([])
    expect(screen.getByText("Nothing shared as a network drive yet.")).toBeInTheDocument()
  })

  it("shows what each share covers, how and who signs in", () => {
    renderList([view("a")], { showConversation: true })
    const row = screen.getByTestId("live-grant-a")
    expect(within(row).getByText("Share a")).toBeInTheDocument()
    expect(within(row).getByText("Active")).toBeInTheDocument()
    expect(within(row).getByText("/workspace/src")).toBeInTheDocument()
    expect(within(row).getByText("cg_a")).toBeInTheDocument()
    expect(within(row).getByText("Conversation s1")).toBeInTheDocument()
    expect(
      within(row).getByText(/See folders and file names · Download files · Expires/)
    ).toBeInTheDocument()
  })

  it("explains why a share is not active", () => {
    renderList([
      view("a", { status: "stale", statusReason: "mount_changed" }),
      view("b", { status: "suspended", statusReason: "mystery" }),
    ])
    expect(
      within(screen.getByTestId("live-grant-a")).getByTestId("live-grant-reason")
    ).toHaveTextContent("A shared folder moved or changed.")
    expect(
      within(screen.getByTestId("live-grant-b")).getByTestId("live-grant-reason")
    ).toHaveTextContent("mystery")
  })

  it("suspends an active share on its host and reloads", async () => {
    const user = userEvent.setup()
    const onChanged = renderList([view("a")])
    await openMenu(user, "Share a")
    expect(screen.queryByRole("menuitem", { name: "Resume" })).toBeNull()
    await user.click(screen.getByRole("menuitem", { name: "Suspend" }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(suspendLiveGrant).toHaveBeenCalledWith("a", { hostId: "local" })
    expect(toast.success).toHaveBeenCalledWith("Access suspended")
  })

  it("resumes a stale share", async () => {
    const user = userEvent.setup()
    renderList([view("a", { status: "stale", statusReason: "mount_changed" })])
    await openMenu(user, "Share a")
    await user.click(screen.getByRole("menuitem", { name: "Resume" }))
    await waitFor(() => expect(resumeLiveGrant).toHaveBeenCalledWith("a", { hostId: "local" }))
  })

  it("asks before revoking", async () => {
    const user = userEvent.setup()
    renderList([view("a")])
    await openMenu(user, "Share a")
    await user.click(screen.getByRole("menuitem", { name: "Revoke" }))
    expect(revokeLiveGrant).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(revokeLiveGrant).toHaveBeenCalledWith("a", { hostId: "local" }))
    expect(toast.success).toHaveBeenCalledWith("Access revoked")
  })

  it("offers nothing but its activity once a share has ended", async () => {
    const user = userEvent.setup()
    renderList([view("a", { status: "revoked", statusReason: "revoked" })])
    await openMenu(user, "Share a")
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Activity"])
  })

  it("shows a reissued password once, with the provider's endpoints", async () => {
    const user = userEvent.setup()
    ;(rotateLiveCredential as jest.Mock).mockResolvedValue({
      credential: view("a").credentials[0],
      password: "new-secret",
    })
    renderList([view("a", { provider: "sftpgo" })])
    await openMenu(user, "Share a")
    await user.click(screen.getByRole("menuitem", { name: "New WebDAV password" }))
    expect(await screen.findByText("New password for cg_a")).toBeInTheDocument()
    expect(rotateLiveCredential).toHaveBeenCalledWith("fc_a", { hostId: "local" })
    expect(screen.getAllByText("https://files.example.com/dav/").length).toBeGreaterThan(0)
  })

  it("explains a refused action and still reloads", async () => {
    const user = userEvent.setup()
    ;(suspendLiveGrant as jest.Mock).mockRejectedValueOnce({
      code: "grant_not_active",
      message: "x",
      retryable: false,
    })
    const onChanged = renderList([view("a")])
    await openMenu(user, "Share a")
    await user.click(screen.getByRole("menuitem", { name: "Suspend" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This access is not active."))
    expect(onChanged).toHaveBeenCalled()
  })

  it("opens one share's activity", async () => {
    const user = userEvent.setup()
    renderList([view("a")])
    await openMenu(user, "Share a")
    await user.click(screen.getByRole("menuitem", { name: "Activity" }))
    expect(await screen.findByTestId("audit")).toBeInTheDocument()
    expect(mockAudit).toHaveBeenLastCalledWith({ grantId: "a", hostId: "local" })
  })
})
