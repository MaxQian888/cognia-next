import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: jest.fn(),
}))
jest.mock("@/hooks/filespace/use-live-file-share", () => ({ useLiveFileShare: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ transport: { kind: "routed" } }))
const mockBlocks = { listener: jest.fn(), sftpgo: jest.fn(), access: jest.fn() }
jest.mock("../blocks/network-drive-block", () => ({
  NetworkDriveBlock: (props: Record<string, unknown>) => {
    mockBlocks.listener(props)
    return <div data-testid="listener-block" />
  },
}))
jest.mock("../blocks/sftpgo-block", () => ({
  SftpgoBlock: (props: Record<string, unknown>) => {
    mockBlocks.sftpgo(props)
    return <div data-testid="sftpgo-block" />
  },
}))
jest.mock("../blocks/live-access-block", () => ({
  LiveAccessBlock: (props: Record<string, unknown>) => {
    mockBlocks.access(props)
    return <div data-testid="access-block" />
  },
}))

import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { useLiveFileShare } from "@/hooks/filespace/use-live-file-share"
import { transport } from "@/lib/tauri"

import { NetworkDrivePanel } from "./network-drive-panel"

const reachMock = useHostAdminReachForCommand as jest.Mock
const liveMock = useLiveFileShare as jest.Mock

const status = {
  active: true,
  listener: { config: { enabled: true } },
  sftpgo: { config: null },
  pendingProviderOps: 1,
}

function live(patch: Record<string, unknown> = {}) {
  return {
    status,
    grants: [],
    error: null,
    errorMessage: null,
    loading: false,
    reload: jest.fn(),
    ...patch,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  reachMock.mockReturnValue({ available: true })
  liveMock.mockReturnValue(live())
})

describe("NetworkDrivePanel", () => {
  it("stacks the listener, SFTPGo and every share for the driven Host", () => {
    const state = live()
    liveMock.mockReturnValue(state)
    render(<NetworkDrivePanel />)
    const ids = ["listener-block", "sftpgo-block", "access-block"]
    const nodes = ids.map((id) => screen.getByTestId(id))
    for (let i = 1; i < nodes.length; i += 1) {
      expect(
        nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
    expect(reachMock).toHaveBeenCalledWith("file_share_listener_set")
    expect(liveMock).toHaveBeenCalledWith({ transport, enabled: true })
    expect(mockBlocks.listener).toHaveBeenCalledWith(
      expect.objectContaining({
        listener: status.listener,
        target: { transport },
        onSaved: state.reload,
      })
    )
    expect(mockBlocks.sftpgo).toHaveBeenCalledWith(
      expect.objectContaining({ pendingProviderOps: 1, target: { transport } })
    )
    expect(mockBlocks.access).toHaveBeenCalledWith(
      expect.objectContaining({ live: state, status, transport })
    )
  })

  it("says why the Host cannot be configured from here", () => {
    reachMock.mockReturnValue({ available: false, block: "no-host" })
    render(<NetworkDrivePanel />)
    expect(screen.getByTestId("network-drive-reach")).toHaveAttribute("data-reach", "no-host")
    expect(liveMock).toHaveBeenCalledWith({ transport, enabled: false })
    expect(screen.queryByTestId("listener-block")).toBeNull()
  })

  it("says the Host cannot share live, with nothing to retry", () => {
    liveMock.mockReturnValue(live({ status: null, error: "unknown_command" }))
    render(<NetworkDrivePanel />)
    expect(screen.getByRole("alert")).toHaveTextContent("This host is too old to share files live.")
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })

  it("offers a retry for a failure that may pass", async () => {
    const user = userEvent.setup()
    const state = live({ status: null, error: "store_failed", errorMessage: "disk" })
    liveMock.mockReturnValue(state)
    render(<NetworkDrivePanel />)
    await user.click(screen.getByRole("button", { name: "Try again" }))
    expect(state.reload).toHaveBeenCalled()
  })

  it("waits for the Host, and asks to unlock a locked one", () => {
    liveMock.mockReturnValue(live({ status: null }))
    const { rerender } = render(<NetworkDrivePanel />)
    expect(screen.getByTestId("network-drive-loading")).toBeInTheDocument()
    liveMock.mockReturnValue(live({ status: { ...status, active: false } }))
    rerender(<NetworkDrivePanel />)
    expect(screen.getByRole("status")).toHaveTextContent("Unlock your account")
    expect(screen.queryByTestId("listener-block")).toBeNull()
  })
})
