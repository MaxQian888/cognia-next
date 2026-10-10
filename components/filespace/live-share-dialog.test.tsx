import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// The dialog creates through the one door (`createLiveFileShare`), whose own
// suite pins the shared-conversation check in front of the host.
jest.mock("@/lib/filespace/live-share", () => ({ createLiveFileShare: jest.fn() }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))
jest.mock("@/hooks/collab/use-shared-session-members", () => ({
  useSharedSessionMembers: jest.fn((scope: unknown) =>
    scope
      ? {
          loaded: true,
          selfUserId: "usr_me",
          members: [
            {
              sessionId: "ses_1",
              userId: "usr_me",
              role: "owner",
              approver: true,
              guest: false,
              createdAt: 0,
              updatedAt: 0,
            },
            {
              sessionId: "ses_1",
              userId: "usr_ana",
              displayName: "Ana",
              role: "member",
              approver: false,
              guest: false,
              createdAt: 0,
              updatedAt: 0,
            },
            {
              sessionId: "ses_1",
              userId: "usr_bo",
              role: "viewer",
              approver: false,
              guest: false,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        }
      : { loaded: true, selfUserId: null, members: [] }
  ),
}))

import { createLiveFileShare } from "@/lib/filespace/live-share"
import { DEFAULT_FILE_SHARING_POLICY } from "@/lib/filespace/policy"
import type { FileSpaceDexieListing } from "@/lib/filespace/sources"
import type { ConversationFileSpace, FileSpaceDexieEntry, FileSpacePath } from "@/types/filespace"
import type { CreatedLiveGrant, FileShareStatus } from "@/types/filespace/live"

import {
  initialAudience,
  LiveShareDialog,
  liveShareBlock,
  liveTtlOptions,
  selectionIsWritable,
} from "./live-share-dialog"

const createMock = createLiveFileShare as jest.Mock
const p = (value: string) => value as FileSpacePath
const DAY = 24 * 60 * 60

const space: ConversationFileSpace = {
  sessionId: "s1",
  status: "available",
  hostId: "local",
  mounts: [
    {
      id: "workspace",
      virtualPath: "/workspace",
      backing: "disk",
      label: "repo",
      hostPath: "/repo",
      managed: false,
      role: "primary",
      writable: true,
      status: "available",
    },
    {
      id: "uploads",
      virtualPath: "/uploads",
      backing: "dexie",
      label: "Uploads",
      managed: false,
      writable: false,
      status: "available",
    },
  ],
}

const upload: FileSpaceDexieEntry = {
  mountId: "uploads",
  path: p("/uploads/a.png"),
  name: "a.png",
  size: 3,
  mediaType: "image/png",
  createdAt: 1,
  updatedAt: 1,
  sourceId: "asset-1",
  sourceAvailable: true,
}
const dexie: FileSpaceDexieListing = { uploads: [upload], artifacts: [] }

function status(patch: Partial<FileShareStatus> = {}, policy: object = {}): FileShareStatus {
  return {
    active: true,
    accountId: "acct",
    policy: {
      ...DEFAULT_FILE_SHARING_POLICY,
      allowProtocolCredentials: true,
      allowLiveWrite: true,
      orgId: null,
      orgRevision: null,
      revision: 1,
      updatedAt: 1,
      ...policy,
    },
    listener: {
      config: {
        enabled: true,
        exposure: "loopback",
        webdav: true,
        sftp: true,
        webdavPort: 27893,
        sftpPort: 27894,
        tunnelMode: "quick",
        tunnelHostname: null,
      },
      webdavPort: 27893,
      sftpPort: 27894,
      tunnelUrl: null,
      tunnelPid: null,
      tunnelTokenSet: false,
      errors: [],
      endpoints: {
        webdavUrls: ["http://127.0.0.1:27893/"],
        sftp: [{ host: "127.0.0.1", port: 27894 }],
        sftpHostKeyFingerprint: "SHA256:h",
        tlsFingerprint: null,
        unavailableReason: null,
      },
    },
    sftpgo: {
      configured: false,
      config: null,
      apiKeySet: false,
      healthy: null,
      error: null,
      endpoints: {
        webdavUrls: [],
        sftp: [],
        sftpHostKeyFingerprint: null,
        tlsFingerprint: null,
        unavailableReason: "sftpgo_unconfigured",
      },
    },
    sessionsWithGrants: [],
    activeGrants: 0,
    liveConnections: 0,
    pendingProviderOps: 0,
    ...patch,
  }
}

const created: CreatedLiveGrant = {
  grant: { id: "fg_1" } as CreatedLiveGrant["grant"],
  credentials: [
    {
      credential: {
        id: "fc_1",
        grantId: "fg_1",
        protocol: "webdav",
        provider: "builtin",
        username: "cg_user",
        sshKeyFingerprint: null,
        createdAt: 1,
        rotatedAt: null,
        revokedAt: null,
      },
      password: "secret-pw",
    },
  ],
  endpoints: status().listener.endpoints,
}

function renderDialog(props: Partial<React.ComponentProps<typeof LiveShareDialog>> = {}): {
  onCreated: jest.Mock
  onOpenChange: jest.Mock
} {
  const onCreated = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <LiveShareDialog
      open
      onOpenChange={onOpenChange}
      space={space}
      dexie={dexie}
      status={status()}
      initialSelection={[p("/workspace")]}
      onCreated={onCreated}
      listDir={jest.fn(async () => [])}
      {...props}
    />
  )
  return { onCreated, onOpenChange }
}

beforeEach(() => {
  jest.clearAllMocks()
  createMock.mockResolvedValue(created)
})

describe("liveShareBlock", () => {
  it("names what keeps the host from issuing a grant", () => {
    expect(liveShareBlock(status())).toBeNull()
    expect(liveShareBlock(status({ active: false }))).toBe("locked")
    expect(liveShareBlock(status({}, { allowLiveGrants: false }))).toBe("liveDisabled")
    expect(liveShareBlock(status({}, { allowProtocolCredentials: false }))).toBe(
      "credentialsDisabled"
    )
    // Members need live access, not credentials.
    expect(liveShareBlock(status({}, { allowProtocolCredentials: false }), "members")).toBeNull()
    expect(liveShareBlock(status({}, { allowLiveGrants: false }), "members")).toBe("liveDisabled")
  })

  it("starts a shared conversation's share on its members", () => {
    expect(initialAudience(status(), true)).toBe("members")
    expect(initialAudience(status(), false)).toBe("credentials")
    expect(initialAudience(status({}, { allowProtocolCredentials: false }), false)).toBeNull()
    expect(initialAudience(status({}, { allowProtocolCredentials: false }), true)).toBe("members")
    expect(initialAudience(status({ active: false }), true)).toBeNull()
  })
})

describe("liveTtlOptions", () => {
  it("offers the presets up to the ceiling and starts on a day", () => {
    expect(liveTtlOptions(7 * DAY)).toEqual({ options: [3600, DAY, 7 * DAY], initial: DAY })
  })

  it("adds an odd ceiling and starts on the longest choice when a day is too long", () => {
    expect(liveTtlOptions(2 * 3600)).toEqual({ options: [3600, 7200], initial: 7200 })
  })
})

describe("selectionIsWritable", () => {
  it("is writable only inside a writable disk mount", () => {
    expect(selectionIsWritable(space, [p("/workspace/src")])).toBe(true)
    expect(selectionIsWritable(space, [p("/workspace"), p("/uploads/a.png")])).toBe(false)
  })
})

describe("LiveShareDialog", () => {
  it("creates a grant on the conversation's host and shows the one-time sign-in", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByLabelText("Label"), "  for Ana  ")
    await user.click(screen.getByLabelText("Make changes"))
    await user.click(screen.getByLabelText("SFTP"))
    await user.type(screen.getByLabelText("SSH public key (optional)"), "ssh-ed25519 AAAA")
    await user.click(screen.getByRole("button", { name: "Create access" }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        paths: ["/workspace"],
        permissions: ["read", "download", "write"],
        protocols: ["webdav", "sftp"],
        provider: "builtin",
        expiresInSeconds: DAY,
        label: "for Ana",
        sshPublicKey: "ssh-ed25519 AAAA",
      },
      { hostId: "local" }
    )
    expect(onCreated).toHaveBeenCalledWith(created)
    expect(await screen.findByText("Network drive access created")).toBeInTheDocument()
    expect(screen.getByText("cg_user")).toBeInTheDocument()
  })

  it("shows the reason instead of a form when the host refuses every grant", () => {
    renderDialog({ status: status({}, { allowProtocolCredentials: false }) })
    const blocked = screen.getByTestId("live-share-blocked")
    expect(blocked).toHaveTextContent("Network-drive credentials are turned off")
    expect(within(blocked).getByRole("link", { name: "File-sharing policy" })).toHaveAttribute(
      "href",
      expect.stringContaining("focus=file-sharing-policy")
    )
    expect(screen.queryByRole("button", { name: "Create access" })).toBeNull()
  })

  it("asks to unlock rather than to change the policy while the host is locked", () => {
    renderDialog({ status: status({ active: false }) })
    expect(screen.getByTestId("live-share-blocked")).toHaveTextContent("Unlock your account")
    expect(screen.queryByRole("link", { name: "File-sharing policy" })).toBeNull()
  })

  it("does not offer changes the policy or the chosen files forbid", async () => {
    const user = userEvent.setup()
    renderDialog({ status: status({}, { allowLiveWrite: false }) })
    expect(screen.getByLabelText("Make changes")).toBeDisabled()
    expect(
      screen.getByText("Changes are turned off by your file-sharing policy.")
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
  })

  it("drops write once an upload joins the selection", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByLabelText("Make changes"))
    expect(screen.getByLabelText("Make changes")).toBeChecked()
    await user.click(screen.getByRole("checkbox", { name: /a\.png/ }))
    expect(screen.getByLabelText("Make changes")).not.toBeChecked()
    expect(screen.getByLabelText("Make changes")).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Create access" }))
    await waitFor(() => expect(createMock).toHaveBeenCalled())
    expect(createMock.mock.calls[0]![0].permissions).toEqual(["read", "download"])
  })

  it("warns when the listener or a chosen protocol is off", async () => {
    const user = userEvent.setup()
    const base = status()
    renderDialog({
      status: {
        ...base,
        listener: { ...base.listener, config: { ...base.listener.config, sftp: false } },
      },
    })
    expect(screen.queryByTestId("live-share-listener-warning")).toBeNull()
    await user.click(screen.getByLabelText("SFTP"))
    expect(screen.getByTestId("live-share-listener-warning")).toHaveTextContent(
      "SFTP is turned off in this host's network drive settings."
    )
  })

  it("warns that a share will not be reachable while the network drive is off", () => {
    const base = status()
    renderDialog({
      status: {
        ...base,
        listener: { ...base.listener, config: { ...base.listener.config, enabled: false } },
      },
    })
    const warning = screen.getByTestId("live-share-listener-warning")
    expect(warning).toHaveTextContent("The network drive is off on this host")
    expect(within(warning).getByRole("link", { name: "Network drive settings" })).toHaveAttribute(
      "href",
      expect.stringContaining("connectivityPanel=network-drive")
    )
  })

  it("offers SFTPGo only where it is configured", () => {
    renderDialog()
    expect(screen.queryByLabelText("Served by")).toBeNull()
  })

  it("serves through SFTPGo when chosen, without the listener warning", async () => {
    const user = userEvent.setup()
    const base = status()
    renderDialog({
      status: {
        ...base,
        listener: { ...base.listener, config: { ...base.listener.config, enabled: false } },
        sftpgo: { ...base.sftpgo, configured: true },
      },
    })
    await user.click(screen.getByLabelText("Served by"))
    await user.click(screen.getByRole("option", { name: "SFTPGo" }))
    expect(screen.queryByTestId("live-share-listener-warning")).toBeNull()
    // SFTPGo's WebDAV leaks a hidden file's size and date: SFTP is the default.
    expect(screen.getByLabelText("SFTP")).toBeChecked()
    expect(screen.getByLabelText("WebDAV")).not.toBeChecked()
    expect(screen.queryByTestId("live-share-sftpgo-webdav")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Create access" }))
    await waitFor(() => expect(createMock).toHaveBeenCalled())
    expect(createMock.mock.calls[0]![0].provider).toBe("sftpgo")
    expect(createMock.mock.calls[0]![0].protocols).toEqual(["sftp"])
  })

  it("explains what WebDAV through SFTPGo reveals when it is opted into", async () => {
    const user = userEvent.setup()
    const base = status()
    renderDialog({ status: { ...base, sftpgo: { ...base.sftpgo, configured: true } } })
    await user.click(screen.getByLabelText("Served by"))
    await user.click(screen.getByRole("option", { name: "SFTPGo" }))
    await user.click(screen.getByLabelText("WebDAV"))
    expect(screen.getByTestId("live-share-sftpgo-webdav")).toHaveTextContent(
      "reveal that the file exists, with its size and date"
    )
    await user.click(screen.getByLabelText("Served by"))
    await user.click(screen.getByRole("option", { name: "This host" }))
    expect(screen.queryByTestId("live-share-sftpgo-webdav")).toBeNull()
  })

  it("will not submit without files or a protocol", async () => {
    const user = userEvent.setup()
    renderDialog({ initialSelection: [] })
    expect(screen.getByRole("button", { name: "Create access" })).toBeDisabled()
    await user.click(screen.getByRole("checkbox", { name: /a\.png/ }))
    expect(screen.getByRole("button", { name: "Create access" })).toBeEnabled()
    await user.click(screen.getByLabelText("WebDAV"))
    expect(screen.getByRole("button", { name: "Create access" })).toBeDisabled()
  })

  it("explains a refusal from the host", async () => {
    const user = userEvent.setup()
    createMock.mockRejectedValue({ code: "mount_not_synced", message: "x", retryable: false })
    renderDialog()
    await user.click(screen.getByRole("button", { name: "Create access" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This host has not seen this conversation's files yet."
    )
  })

  it("explains a shared conversation whose files the person may not share", async () => {
    const user = userEvent.setup()
    createMock.mockRejectedValue({
      code: "shared_session_forbidden",
      message: "x",
      retryable: false,
    })
    renderDialog()
    await user.click(screen.getByRole("button", { name: "Create access" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your role in this shared conversation does not let you share its files."
    )
  })

  describe("for a shared conversation's members", () => {
    const sharedScope = { orgId: "org_1", sessionId: "ses_1" }
    const membersCreated = {
      grant: { id: "fg_2", audience: { kind: "collab" } },
      credentials: [],
      endpoints: status().listener.endpoints,
    } as unknown as CreatedLiveGrant

    it("shares with everyone at a role, without protocols or a sign-in", async () => {
      const user = userEvent.setup()
      createMock.mockResolvedValue(membersCreated)
      // Members are offered even where network-drive credentials are off.
      renderDialog({ sharedScope, status: status({}, { allowProtocolCredentials: false }) })
      expect(screen.queryByTestId("live-share-blocked")).toBeNull()
      expect(screen.getByTestId("live-share-members")).toBeInTheDocument()
      expect(screen.queryByText("Protocols")).toBeNull()
      expect(screen.queryByTestId("live-share-listener-warning")).toBeNull()
      await user.click(screen.getByLabelText("Lowest role"))
      await user.click(await screen.findByRole("option", { name: "Member" }))
      await user.click(screen.getByLabelText("Make changes"))
      expect(
        screen.getByText("Viewers can only ever read, even when changes are allowed.")
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Create access" }))
      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
      expect(createMock).toHaveBeenCalledWith(
        {
          sessionId: "s1",
          paths: ["/workspace"],
          permissions: ["read", "download", "write"],
          expiresInSeconds: DAY,
          protocols: [],
          audience: { kind: "collab", minRole: "member" },
        },
        { hostId: "local" }
      )
      expect(await screen.findByText("Shared with the conversation's members")).toBeInTheDocument()
      expect(screen.queryByText("Password")).toBeNull()
    })

    it("names chosen members, never the person sharing", async () => {
      const user = userEvent.setup()
      createMock.mockResolvedValue(membersCreated)
      renderDialog({ sharedScope })
      await user.click(screen.getByRole("combobox", { name: "Which members" }))
      await user.click(await screen.findByRole("option", { name: "Only the members I choose" }))
      expect(screen.queryByLabelText("usr_me")).toBeNull()
      expect(screen.getByRole("button", { name: "Create access" })).toBeDisabled()
      await user.click(screen.getByLabelText("Ana"))
      await user.click(screen.getByRole("button", { name: "Create access" }))
      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
      expect(createMock.mock.calls[0][0].audience).toEqual({
        kind: "collab",
        userIds: ["usr_ana"],
        minRole: "viewer",
      })
    })

    it("can still switch to a network-drive sign-in", async () => {
      const user = userEvent.setup()
      renderDialog({ sharedScope })
      await user.click(screen.getByLabelText("Share with"))
      await user.click(
        await screen.findByRole("option", { name: "A network drive sign-in (WebDAV/SFTP)" })
      )
      expect(screen.getByText("Protocols")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Create access" }))
      await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
      expect(createMock.mock.calls[0][0]).not.toHaveProperty("audience")
      expect(createMock.mock.calls[0][0].protocols).toEqual(["webdav"])
    })
  })
})
