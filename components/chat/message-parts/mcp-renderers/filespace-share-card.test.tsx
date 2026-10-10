/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolUIPart } from "ai"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))
jest.mock("@/lib/filespace/grants-client", () => ({
  ...jest.requireActual("@/lib/filespace/grants-client"),
  rotateLiveCredential: jest.fn(),
}))

import { toast } from "sonner"
import { rotateLiveCredential } from "@/lib/filespace/grants-client"
import { writeClipboardText } from "@/lib/tauri/clipboard"

import { FilespaceShareCard } from "./filespace-share-card"

const rotateMock = rotateLiveCredential as jest.Mock

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-filespace_share",
    toolCallId: "c1",
    state: "output-available",
    input: {},
    output,
  } as unknown as ToolUIPart
}

const live = {
  ok: true,
  mode: "live",
  grantId: "fg_1",
  hostId: "host-a",
  status: "active",
  paths: ["/workspace/src"],
  expiresAt: 4_000_000_000_000,
  credentials: [{ credentialId: "fc_1", protocol: "webdav", username: "cg_abc" }],
  endpoints: {
    webdavUrls: ["https://192.168.1.2:27893/"],
    sftp: [],
    sftpHostKeyFingerprint: null,
    tlsFingerprint: null,
    unavailableReason: null,
  },
  password: "Not given to the agent.",
}

beforeEach(() => jest.clearAllMocks())

describe("FilespaceShareCard", () => {
  it("shows a snapshot's link with a copy button", async () => {
    const user = userEvent.setup()
    render(
      <FilespaceShareCard
        part={part({
          ok: true,
          mode: "snapshot",
          code: "AbC",
          url: "https://share.example/s/AbC#key",
          expiresAt: 4_000_000_000_000,
          files: 3,
          withheldSensitive: 2,
        })}
      />
    )
    const card = screen.getByTestId("filespace-share-snapshot")
    expect(card).toHaveTextContent("Shared 3 files as a link")
    expect(card).toHaveTextContent("https://share.example/s/AbC#key")
    expect(card).toHaveTextContent("2 files holding secrets were left out.")
    await user.click(screen.getByRole("button", { name: "Copy link" }))
    expect(writeClipboardText).toHaveBeenCalledWith("https://share.example/s/AbC#key")
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Link copied."))
  })

  it("issues the password the agent never saw, on the host that serves it", async () => {
    const user = userEvent.setup()
    rotateMock.mockResolvedValue({
      credential: {
        id: "fc_1",
        grantId: "fg_1",
        protocol: "webdav",
        provider: "builtin",
        username: "cg_abc",
        sshKeyFingerprint: null,
        createdAt: 1,
        rotatedAt: 2,
        revokedAt: null,
      },
      password: "fresh-password",
    })
    render(<FilespaceShareCard part={part(live)} />)
    const card = screen.getByTestId("filespace-share-live")
    expect(card).toHaveTextContent("Shared as a network drive")
    expect(card).toHaveTextContent("/workspace/src")
    expect(card).not.toHaveTextContent("fresh-password")
    await user.click(screen.getByRole("button", { name: "Issue WebDAV password (cg_abc)" }))
    expect(rotateMock).toHaveBeenCalledWith("fc_1", { hostId: "host-a" })
    expect(await screen.findByTestId("live-share-credentials")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent("New password for cg_abc")
  })

  it("says why a password could not be issued", async () => {
    const user = userEvent.setup()
    rotateMock.mockRejectedValue({ code: "credential_revoked", message: "x", retryable: false })
    render(<FilespaceShareCard part={part(live)} />)
    await user.click(screen.getByRole("button", { name: "Issue WebDAV password (cg_abc)" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("That sign-in was already revoked.")
    )
  })

  it("names who a members share admits, with no password to issue", () => {
    render(
      <FilespaceShareCard
        part={part({
          ok: true,
          mode: "live",
          audience: "members",
          grantId: "fg_m",
          hostId: "host-a",
          status: "active",
          minRole: "member",
          permissions: ["read", "download"],
          paths: ["/workspace/src", "/uploads"],
          expiresAt: 4_000_000_000_000,
        })}
      />
    )
    const card = screen.getByTestId("filespace-share-members")
    expect(card).toHaveTextContent("Shared with the conversation's members")
    expect(card).toHaveTextContent("Members · Member and up")
    expect(card).toHaveTextContent("/workspace/src, /uploads")
    expect(card).toHaveTextContent("No password is created")
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByTestId("filespace-share-live")).toBeNull()
  })

  it("renders nothing for a refusal or a result still streaming", () => {
    const { container, rerender } = render(
      <FilespaceShareCard part={part({ ok: false, error: "no" })} />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<FilespaceShareCard part={part(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
