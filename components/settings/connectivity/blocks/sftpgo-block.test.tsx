import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/filespace/grants-client", () => ({
  ...jest.requireActual("@/lib/filespace/grants-client"),
  setSftpgoProvider: jest.fn(async () => ({})),
}))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn(async () => undefined) }))

import { toast } from "sonner"
import { setSftpgoProvider } from "@/lib/filespace/grants-client"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SftpgoStatus } from "@/types/filespace/live"

import { SftpgoBlock, sftpgoConfigOf } from "./sftpgo-block"

const setMock = setSftpgoProvider as jest.Mock
const target = { transport: { call: jest.fn() } as unknown as Transport }

const NONE: SftpgoStatus = {
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
}

const CONFIGURED: SftpgoStatus = {
  configured: true,
  config: {
    baseUrl: "http://sftpgo:8080",
    homeBase: "/srv/homes",
    pathMappings: [{ hostPrefix: "/data/ws", sftpgoPrefix: "/srv/ws" }],
    publicSftpHost: "files.example.com",
    publicSftpPort: 2022,
    publicWebdavUrl: null,
  },
  apiKeySet: true,
  healthy: false,
  error: "connection refused",
  endpoints: {
    webdavUrls: [],
    sftp: [{ host: "files.example.com", port: 2022 }],
    sftpHostKeyFingerprint: null,
    tlsFingerprint: null,
    unavailableReason: null,
  },
}

function renderBlock(sftpgo: SftpgoStatus, pendingProviderOps = 0) {
  const onSaved = jest.fn()
  render(
    <SftpgoBlock
      sftpgo={sftpgo}
      pendingProviderOps={pendingProviderOps}
      target={target}
      onSaved={onSaved}
    />
  )
  return onSaved
}

beforeEach(() => jest.clearAllMocks())

describe("sftpgoConfigOf", () => {
  it("trims, drops half-filled mappings and blank optionals", () => {
    expect(
      sftpgoConfigOf({
        baseUrl: " http://x ",
        apiKey: "",
        homeBase: "/h",
        pathMappings: [
          { hostPrefix: "/a", sftpgoPrefix: "/b" },
          { hostPrefix: "/c", sftpgoPrefix: " " },
        ],
        publicSftpHost: "",
        publicSftpPort: "abc",
        publicWebdavUrl: " https://d/ ",
      })
    ).toEqual({
      baseUrl: "http://x",
      homeBase: "/h",
      pathMappings: [{ hostPrefix: "/a", sftpgoPrefix: "/b" }],
      publicSftpHost: null,
      publicSftpPort: null,
      publicWebdavUrl: "https://d/",
    })
  })
})

describe("SftpgoBlock", () => {
  it("configures SFTPGo with its key and a path mapping", async () => {
    const user = userEvent.setup()
    const onSaved = renderBlock(NONE)
    expect(screen.getByText("Not configured")).toBeInTheDocument()
    // Collapsed until configured: most hosts never use it.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    await user.click(screen.getByRole("button", { name: /SFTPGo/ }))
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText("Admin API URL"), "http://sftpgo:8080")
    await user.type(screen.getByLabelText("Home directory base"), "/srv/homes")
    await user.type(screen.getByRole("textbox", { name: "Path on this host" }), "/data/ws")
    await user.type(screen.getByRole("textbox", { name: "Path SFTPGo sees" }), "/srv/ws")
    // A first configuration needs the key.
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText("Admin API key"), "k-1")
    await user.type(screen.getByLabelText("Public SFTP host"), "files.example.com")
    await user.click(save)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(setMock).toHaveBeenCalledWith(
      {
        baseUrl: "http://sftpgo:8080",
        homeBase: "/srv/homes",
        pathMappings: [{ hostPrefix: "/data/ws", sftpgoPrefix: "/srv/ws" }],
        publicSftpHost: "files.example.com",
        publicSftpPort: null,
        publicWebdavUrl: null,
        apiKey: "k-1",
      },
      target
    )
    expect(toast.success).toHaveBeenCalledWith("SFTPGo settings saved")
  })

  it("keeps the stored key when the field is left empty, and edits mappings", async () => {
    const user = userEvent.setup()
    renderBlock(CONFIGURED)
    expect(screen.getByText("A key is saved. Leave this empty to keep it.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Add mapping" }))
    const hosts = screen.getAllByRole("textbox", { name: "Path on this host" })
    const sftpgo = screen.getAllByRole("textbox", { name: "Path SFTPGo sees" })
    await user.type(hosts[1]!, "/data/more")
    await user.type(sftpgo[1]!, "/srv/more")
    await user.click(screen.getAllByRole("button", { name: "Remove mapping" })[0]!)
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const sent = setMock.mock.calls[0]![0]
    expect(sent).not.toHaveProperty("apiKey")
    expect(sent.pathMappings).toEqual([{ hostPrefix: "/data/more", sftpgoPrefix: "/srv/more" }])
  })

  it("shows its health, retries waiting, and where its users dial", () => {
    renderBlock(CONFIGURED, 2)
    expect(screen.getByText("Not reachable")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("connection refused")
    expect(screen.getByText("2 SFTPGo changes are waiting to be retried.")).toBeInTheDocument()
    expect(
      within(screen.getByTestId("sftpgo-addresses")).getByText("files.example.com:2022")
    ).toBeInTheDocument()
  })

  it("says when SFTPGo has nowhere public to dial", () => {
    renderBlock({
      ...CONFIGURED,
      healthy: true,
      error: null,
      endpoints: {
        ...CONFIGURED.endpoints,
        sftp: [],
        unavailableReason: "sftpgo_no_public_endpoint",
      },
    })
    expect(screen.getByText("Reachable")).toBeInTheDocument()
    expect(screen.getByText(/SFTPGo has no public address configured/)).toBeInTheDocument()
  })

  it("asks before removing SFTPGo", async () => {
    const user = userEvent.setup()
    const onSaved = renderBlock(CONFIGURED)
    await user.click(screen.getByRole("button", { name: "Remove SFTPGo" }))
    expect(setMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(setMock).toHaveBeenCalledWith(null, target))
    expect(onSaved).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("SFTPGo removed")
  })

  it("explains a refused save", async () => {
    const user = userEvent.setup()
    setMock.mockRejectedValueOnce({
      code: "secret_store_unavailable",
      message: "x",
      retryable: false,
    })
    renderBlock(CONFIGURED)
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The system keychain is not available.")
    )
  })
})
