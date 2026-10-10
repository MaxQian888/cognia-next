/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/files/download", () => ({
  downloadBlob: jest.fn(async () => ({ kind: "downloaded" })),
}))
jest.mock("@/lib/collab/file-requests", () => ({
  ...jest.requireActual("@/lib/collab/file-requests"),
  listMemberFolder: jest.fn(),
  readMemberFile: jest.fn(),
  writeMemberFile: jest.fn(),
  makeMemberFolder: jest.fn(),
  deleteMemberPath: jest.fn(),
  renameMemberPath: jest.fn(),
}))

import { toast } from "sonner"
import type { CollabFileGrant, CollabFileHost } from "@/lib/collab/client"
import {
  deleteMemberPath,
  listMemberFolder,
  makeMemberFolder,
  MemberFileError,
  readMemberFile,
  renameMemberPath,
  writeMemberFile,
} from "@/lib/collab/file-requests"
import { downloadBlob } from "@/lib/files/download"

import { SharedSessionFiles } from "./shared-session-files"

const listMock = listMemberFolder as jest.Mock

function grant(patch: Partial<CollabFileGrant> = {}): CollabFileGrant {
  return {
    id: "fg_1",
    sessionId: "ses_1",
    label: "Design files",
    userIds: null,
    minRole: "viewer",
    permissions: ["read", "download", "write"],
    paths: [{ path: "/workspace/src", isDir: true }],
    status: "active",
    expiresAt: 4_000_000_000_000,
    revokedAt: null,
    policyRevision: 1,
    createdBy: "usr_host",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function client(host: CollabFileHost, grants: CollabFileGrant[]) {
  return {
    listFileGrants: jest.fn(async () => ({ host, grants })),
    createFileRequest: jest.fn(),
    getFileRequest: jest.fn(),
    uploadFileRequestBytes: jest.fn(),
    downloadFileRequestResult: jest.fn(),
    unregisterFileHost: jest.fn(async () => undefined),
  }
}

const online: CollabFileHost = { registered: true, hostLabel: "Studio Mac", online: true }

beforeEach(() => {
  jest.clearAllMocks()
  listMock.mockResolvedValue({
    entries: [
      { name: "nested", isDir: true, size: 0, modifiedAt: 1 },
      { name: "a.txt", isDir: false, size: 5, modifiedAt: 1 },
    ],
    truncated: false,
  })
})

describe("SharedSessionFiles", () => {
  it("says when no device shares the files, or nothing is shared with this member", async () => {
    const { unmount } = render(
      <SharedSessionFiles
        client={client({ registered: false, online: false }, [])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    expect(
      await screen.findByText("No device is sharing this conversation's files.")
    ).toBeInTheDocument()
    unmount()
    render(
      <SharedSessionFiles
        client={client(online, [])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    expect(await screen.findByText("Nothing has been shared with you yet.")).toBeInTheDocument()
    expect(screen.getByTestId("shared-files-host")).toHaveTextContent("Studio Mac is online")
  })

  it("names the sharing device even when it gave no label", async () => {
    render(
      <SharedSessionFiles
        client={client({ registered: true, online: true }, [grant()])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    expect(await screen.findByTestId("shared-files-host")).toHaveTextContent(
      "The sharing device is online"
    )
  })

  it("warns that requests wait while the holding device is offline", async () => {
    render(
      <SharedSessionFiles
        client={client({ registered: true, hostLabel: "Studio Mac", online: false }, [grant()])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    expect(await screen.findByTestId("shared-files-offline")).toBeInTheDocument()
    expect(screen.getByTestId("shared-files-host")).toHaveTextContent("Studio Mac is offline")
  })

  it("browses a share from its folder and downloads a file", async () => {
    const user = userEvent.setup()
    const blob = new Blob(["alpha"])
    ;(readMemberFile as jest.Mock).mockResolvedValue(blob)
    render(
      <SharedSessionFiles
        client={client(online, [grant()])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    await user.click(await screen.findByRole("button", { name: "Browse" }))
    await screen.findByTestId("shared-files-entry-a.txt")
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", sessionId: "ses_1" }),
      "fg_1",
      "/workspace/src"
    )
    await user.click(screen.getByRole("button", { name: "Download a.txt" }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(blob, "a.txt"))
    expect(readMemberFile).toHaveBeenCalledWith(expect.anything(), "fg_1", "/workspace/src/a.txt")

    await user.click(screen.getByRole("button", { name: "nested" }))
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.anything(), "fg_1", "/workspace/src/nested")
    )
    await screen.findByTestId("shared-files-entry-a.txt")
    await user.click(screen.getByRole("button", { name: "Up one folder" }))
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.anything(), "fg_1", "/workspace/src")
    )
  })

  it("changes files only where the share allows writes and the role is not a viewer", async () => {
    const user = userEvent.setup()
    render(
      <SharedSessionFiles
        client={client(online, [grant()])}
        orgId="org_1"
        sessionId="ses_1"
        role="viewer"
      />
    )
    await user.click(await screen.findByRole("button", { name: "Browse" }))
    await screen.findByTestId("shared-files-entry-a.txt")
    expect(screen.queryByRole("button", { name: "Upload a file" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete a.txt" })).toBeNull()
    expect(screen.getByText(/See names · Download/)).not.toHaveTextContent("Change")
  })

  it("uploads, makes folders, renames and deletes as a member", async () => {
    const user = userEvent.setup()
    render(
      <SharedSessionFiles
        client={client(online, [grant()])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    await user.click(await screen.findByRole("button", { name: "Browse" }))
    await screen.findByTestId("shared-files-entry-a.txt")

    // jsdom's File has no `arrayBuffer`; a browser's does.
    const file = Object.assign(new File(["hello"], "notes.md"), {
      arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
    })
    await user.upload(screen.getByLabelText("File to upload"), file)
    await waitFor(() => expect(writeMemberFile).toHaveBeenCalled())
    const [, grantId, path, bytes] = (writeMemberFile as jest.Mock).mock.calls[0]
    expect([grantId, path, Array.from(bytes as Uint8Array)]).toEqual([
      "fg_1",
      "/workspace/src/notes.md",
      Array.from(new TextEncoder().encode("hello")),
    ])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Uploaded notes.md"))

    await user.click(screen.getByRole("button", { name: "New folder" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Name"), "drafts")
    await user.click(within(dialog).getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(makeMemberFolder).toHaveBeenCalledWith(
        expect.anything(),
        "fg_1",
        "/workspace/src/drafts"
      )
    )

    await user.click(screen.getByRole("button", { name: "Rename a.txt" }))
    const rename = await screen.findByRole("dialog")
    const input = within(rename).getByLabelText("Name")
    await user.clear(input)
    await user.type(input, "../x")
    expect(within(rename).getByRole("button", { name: "Rename" })).toBeDisabled()
    await user.clear(input)
    await user.type(input, "b.txt")
    await user.click(within(rename).getByRole("button", { name: "Rename" }))
    await waitFor(() =>
      expect(renameMemberPath).toHaveBeenCalledWith(
        expect.anything(),
        "fg_1",
        "/workspace/src/a.txt",
        "/workspace/src/b.txt"
      )
    )

    await user.click(screen.getByRole("button", { name: "Delete a.txt" }))
    await waitFor(() =>
      expect(deleteMemberPath).toHaveBeenCalledWith(
        expect.anything(),
        "fg_1",
        "/workspace/src/a.txt"
      )
    )
  })

  it("explains what the holding device refused", async () => {
    const user = userEvent.setup()
    listMock.mockRejectedValue(new MemberFileError("host_unavailable"))
    render(
      <SharedSessionFiles
        client={client(online, [grant()])}
        orgId="org_1"
        sessionId="ses_1"
        role="member"
      />
    )
    await user.click(await screen.findByRole("button", { name: "Browse" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The device holding the files did not answer. It may be offline."
    )
    listMock.mockRejectedValue(new MemberFileError("weird_code"))
    await user.click(screen.getByRole("button", { name: "Browse" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not work (weird_code).")
  })

  it("reads the shares and the open folder again on refresh", async () => {
    const user = userEvent.setup()
    const c = client(online, [grant()])
    render(<SharedSessionFiles client={c} orgId="org_1" sessionId="ses_1" role="member" />)
    await user.click(await screen.findByRole("button", { name: "Browse" }))
    await screen.findByTestId("shared-files-entry-a.txt")
    await user.click(screen.getByRole("button", { name: "Refresh files" }))
    await waitFor(() => expect(c.listFileGrants).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
  })

  it("lets a member who may share remove the sharing device, after confirming", async () => {
    const user = userEvent.setup()
    const c = client(online, [grant()])
    const { unmount } = render(
      <SharedSessionFiles client={c} orgId="org_1" sessionId="ses_1" role="member" />
    )
    await screen.findByTestId("shared-files-host")
    expect(screen.queryByRole("button", { name: "Remove sharing device" })).toBeNull()
    unmount()

    render(
      <SharedSessionFiles client={c} orgId="org_1" sessionId="ses_1" role="owner" canRemoveHost />
    )
    await user.click(await screen.findByRole("button", { name: "Remove sharing device" }))
    expect(c.unregisterFileHost).not.toHaveBeenCalled()
    await user.click(await screen.findByRole("button", { name: "Remove device" }))
    await waitFor(() => expect(c.unregisterFileHost).toHaveBeenCalledWith("org_1", "ses_1"))
    expect(toast.success).toHaveBeenCalledWith("Removed the sharing device")
    await waitFor(() => expect(c.listFileGrants).toHaveBeenCalledTimes(3))

    c.unregisterFileHost.mockRejectedValue(new Error("down"))
    await user.click(screen.getByRole("button", { name: "Remove sharing device" }))
    await user.click(await screen.findByRole("button", { name: "Remove device" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not remove the sharing device. Try again.")
    )
  })

  it("says when the shared files cannot be loaded", async () => {
    const failing = client(online, [])
    failing.listFileGrants.mockRejectedValue(new Error("down"))
    render(<SharedSessionFiles client={failing} orgId="org_1" sessionId="ses_1" role="member" />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the shared files.")
  })
})
