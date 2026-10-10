import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/filespace/grants-client", () => ({
  ...jest.requireActual("@/lib/filespace/grants-client"),
  setFileShareListener: jest.fn(async () => ({})),
}))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))

import { toast } from "sonner"
import { setFileShareListener } from "@/lib/filespace/grants-client"
import type { Transport } from "@/lib/tauri/transport-types"
import type { LiveListenerStatus } from "@/types/filespace/live"

import { listenerDraftProblem, NetworkDriveBlock } from "./network-drive-block"

const setMock = setFileShareListener as jest.Mock
const target = { transport: { call: jest.fn() } as unknown as Transport }

const config = {
  enabled: false,
  exposure: "loopback" as const,
  webdav: true,
  sftp: false,
  webdavPort: 27893,
  sftpPort: 27894,
  tunnelMode: "quick" as const,
  tunnelHostname: null,
}

function listener(patch: Partial<LiveListenerStatus> = {}): LiveListenerStatus {
  return {
    config,
    webdavPort: null,
    sftpPort: null,
    tunnelUrl: null,
    tunnelPid: null,
    tunnelTokenSet: false,
    errors: [],
    endpoints: {
      webdavUrls: [],
      sftp: [],
      sftpHostKeyFingerprint: null,
      tlsFingerprint: null,
      unavailableReason: "listener_off",
    },
    ...patch,
  }
}

function renderBlock(status: LiveListenerStatus = listener()) {
  const onSaved = jest.fn()
  render(<NetworkDriveBlock listener={status} target={target} onSaved={onSaved} />)
  return onSaved
}

beforeEach(() => jest.clearAllMocks())

describe("listenerDraftProblem", () => {
  it("refuses no protocol, out-of-range ports and a shared port", () => {
    expect(listenerDraftProblem(config)).toBeNull()
    expect(listenerDraftProblem({ ...config, webdav: false })).toBe("noProtocol")
    expect(listenerDraftProblem({ ...config, webdavPort: 80 })).toBe("invalidPorts")
    expect(listenerDraftProblem({ ...config, sftpPort: Number.NaN })).toBe("invalidPorts")
    expect(listenerDraftProblem({ ...config, sftp: true, sftpPort: 27893 })).toBe("invalidPorts")
    // A port only clashes with a protocol that is on.
    expect(listenerDraftProblem({ ...config, sftpPort: 27893 })).toBeNull()
  })
})

describe("NetworkDriveBlock", () => {
  it("turns the listener on for the local network and saves it to the host", async () => {
    const user = userEvent.setup()
    const onSaved = renderBlock()
    expect(screen.getByText("Off")).toBeInTheDocument()
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()
    await user.click(screen.getByRole("switch", { name: "Serve network drives" }))
    await user.click(screen.getByRole("radio", { name: "Local network" }))
    await user.click(screen.getByRole("switch", { name: "SFTP" }))
    await user.click(save)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setMock).toHaveBeenCalledWith(
      { ...config, enabled: true, exposure: "lan", sftp: true },
      target
    )
    expect(toast.success).toHaveBeenCalledWith("Network drive settings saved")
  })

  it("asks for a named tunnel's hostname and token, sending the token only when typed", async () => {
    const user = userEvent.setup()
    renderBlock(listener({ tunnelTokenSet: true }))
    expect(screen.queryByLabelText("Tunnel token")).toBeNull()
    await user.click(screen.getByRole("radio", { name: "Internet, through a tunnel" }))
    await user.click(screen.getByRole("radio", { name: "Named tunnel" }))
    expect(screen.getByText("A token is saved. Leave this empty to keep it.")).toBeInTheDocument()
    await user.type(screen.getByLabelText("Public hostname"), " files.example.com ")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    expect(setMock.mock.calls[0]![0]).toEqual({
      ...config,
      exposure: "tunnel",
      tunnelMode: "named",
      tunnelHostname: "files.example.com",
    })

    await user.type(screen.getByLabelText("Tunnel token"), "tok")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(2))
    expect(setMock.mock.calls[1]![0]).toMatchObject({ tunnelToken: "tok" })
  })

  it("will not send a draft the host would refuse", async () => {
    const user = userEvent.setup()
    renderBlock()
    await user.click(screen.getByRole("switch", { name: "WebDAV" }))
    expect(screen.getByRole("alert")).toHaveTextContent("Turn on WebDAV, SFTP or both.")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    await user.click(screen.getByRole("switch", { name: "WebDAV" }))
    const port = screen.getByRole("spinbutton", { name: "WebDAV port" })
    await user.clear(port)
    await user.type(port, "80")
    expect(screen.getByRole("alert")).toHaveTextContent("Ports must be between 1024 and 65535")
  })

  it("explains a refused save", async () => {
    const user = userEvent.setup()
    setMock.mockRejectedValueOnce({ code: "listener_bind_failed", message: "x", retryable: false })
    const onSaved = renderBlock()
    await user.click(screen.getByRole("switch", { name: "Serve network drives" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The port is already in use or cannot be opened.")
    )
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("shows where a running listener answers and what failed", () => {
    renderBlock(
      listener({
        config: { ...config, enabled: true, sftp: true },
        webdavPort: 27893,
        sftpPort: 27894,
        tunnelUrl: "https://abc.trycloudflare.com",
        errors: [{ component: "tunnel", message: "cloudflared missing" }],
        endpoints: {
          webdavUrls: ["http://127.0.0.1:27893/"],
          sftp: [{ host: "127.0.0.1", port: 27894 }],
          sftpHostKeyFingerprint: "SHA256:k",
          tlsFingerprint: null,
          unavailableReason: null,
        },
      })
    )
    expect(screen.getByText("Running")).toBeInTheDocument()
    const addresses = screen.getByTestId("network-drive-addresses")
    expect(within(addresses).getByText("https://abc.trycloudflare.com")).toBeInTheDocument()
    expect(within(addresses).getByText("http://127.0.0.1:27893/")).toBeInTheDocument()
    expect(within(addresses).getByText("127.0.0.1:27894")).toBeInTheDocument()
    expect(within(addresses).getByText("SHA256:k")).toBeInTheDocument()
    expect(screen.getByTestId("network-drive-errors")).toHaveTextContent(
      "tunnel: cloudflared missing"
    )
  })
})
