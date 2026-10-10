import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))

import { toast } from "sonner"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import type { IssuedLiveCredential, LiveEndpoints } from "@/types/filespace/live"

import { LiveShareCredentials } from "./live-share-credentials"

const copyMock = writeClipboardText as jest.Mock

function issued(
  protocol: "webdav" | "sftp",
  username: string,
  password: string
): IssuedLiveCredential {
  return {
    credential: {
      id: `fc_${protocol}`,
      grantId: "fg_1",
      protocol,
      provider: "builtin",
      username,
      sshKeyFingerprint: protocol === "sftp" ? "SHA256:key" : null,
      createdAt: 1,
      rotatedAt: null,
      revokedAt: null,
    },
    password,
  }
}

const endpoints: LiveEndpoints = {
  webdavUrls: ["http://127.0.0.1:27893/"],
  sftp: [{ host: "127.0.0.1", port: 27894 }],
  sftpHostKeyFingerprint: "SHA256:host",
  tlsFingerprint: null,
  unavailableReason: null,
}

beforeEach(() => jest.clearAllMocks())

describe("LiveShareCredentials", () => {
  it("shows each credential with its one-time password masked until asked", async () => {
    const user = userEvent.setup()
    render(
      <LiveShareCredentials
        credentials={[issued("webdav", "cg_web", "pw-web"), issued("sftp", "cg_ssh", "pw-ssh")]}
        endpoints={endpoints}
      />
    )
    expect(screen.getByText(/shown only this once/)).toBeInTheDocument()
    const webdav = screen.getByTestId("live-credential-webdav")
    expect(within(webdav).getByText("cg_web")).toBeInTheDocument()
    expect(within(webdav).getByTestId("live-password")).not.toHaveTextContent("pw-web")
    await user.click(within(webdav).getByRole("button", { name: "Show password" }))
    expect(within(webdav).getByTestId("live-password")).toHaveTextContent("pw-web")
    await user.click(within(webdav).getByRole("button", { name: "Copy Password" }))
    expect(copyMock).toHaveBeenCalledWith("pw-web")
  })

  it("gives Finder, Windows and rclone steps for WebDAV", async () => {
    const user = userEvent.setup()
    render(
      <LiveShareCredentials
        credentials={[issued("webdav", "cg_web", "pw")]}
        endpoints={endpoints}
      />
    )
    const card = screen.getByTestId("live-credential-webdav")
    expect(within(card).getAllByText("http://127.0.0.1:27893/").length).toBeGreaterThan(0)
    await user.click(within(card).getByRole("tab", { name: "Windows" }))
    expect(
      within(card).getByText('net use * "http://127.0.0.1:27893/" /user:cg_web *')
    ).toBeInTheDocument()
    // Plain HTTP: Windows will not send the password without a registry change.
    expect(within(card).getByText(/BasicAuthLevel/)).toBeInTheDocument()
    await user.click(within(card).getByRole("tab", { name: "rclone" }))
    expect(within(card).getByText(/rclone config create cognia-cg_web webdav/)).toBeInTheDocument()
  })

  it("gives the SFTP command, the host key to verify and the SSH key it accepts", () => {
    render(
      <LiveShareCredentials credentials={[issued("sftp", "cg_ssh", "pw")]} endpoints={endpoints} />
    )
    const card = screen.getByTestId("live-credential-sftp")
    expect(within(card).getByText("sftp -P 27894 cg_ssh@127.0.0.1")).toBeInTheDocument()
    expect(within(card).getByText("SHA256:host")).toBeInTheDocument()
    expect(within(card).getByText(/SHA256:key/)).toBeInTheDocument()
  })

  it("says why nothing is reachable instead of offering steps", () => {
    render(
      <LiveShareCredentials
        credentials={[issued("webdav", "cg_web", "pw")]}
        endpoints={{ ...endpoints, webdavUrls: [], sftp: [], unavailableReason: "listener_off" }}
      />
    )
    expect(screen.getByTestId("live-share-unavailable")).toHaveTextContent(
      "The network drive is off on this host."
    )
    expect(
      screen.getByText("Connection steps appear once the share is reachable.")
    ).toBeInTheDocument()
  })

  it("falls back for a reason it does not know, and shows a TLS fingerprint", () => {
    render(
      <LiveShareCredentials
        credentials={[]}
        endpoints={{ ...endpoints, tlsFingerprint: "ab:cd", unavailableReason: "mystery" }}
      />
    )
    expect(screen.getByTestId("live-share-unavailable")).toHaveTextContent(
      "This share cannot be reached right now."
    )
    expect(screen.getByText("ab:cd")).toBeInTheDocument()
  })

  it("says when copying failed", async () => {
    const user = userEvent.setup()
    copyMock.mockRejectedValueOnce(new Error("denied"))
    render(
      <LiveShareCredentials
        credentials={[issued("webdav", "cg_web", "pw")]}
        endpoints={endpoints}
      />
    )
    await user.click(screen.getByRole("button", { name: "Copy Username" }))
    expect(toast.error).toHaveBeenCalledWith("Could not copy.")
  })
})
