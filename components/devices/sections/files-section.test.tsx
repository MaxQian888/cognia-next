import { render, screen } from "@testing-library/react"

import { FilesSection, sshProfileIdFrom } from "./files-section"
import type { DeviceRow } from "@/lib/devices/types"

let reach = { available: true } as { available: boolean }

jest.mock("@/hooks/platform/use-surface-reach", () => ({
  useSurfaceReach: () => reach,
}))
jest.mock("@/components/platform/surface-unavailable-notice", () => ({
  SurfaceUnavailableNotice: (props: Record<string, unknown>) => (
    <p data-testid={String(props["data-testid"])}>unavailable</p>
  ),
}))
jest.mock("@/components/sftp/remote-file-browser", () => ({
  RemoteFileBrowser: (props: Record<string, unknown>) => (
    <div data-testid="browser" data-profile={String(props.profileId)} />
  ),
}))
jest.mock("@/components/sftp/transfer-queue-panel", () => ({
  TransferQueuePanel: (props: Record<string, unknown>) => (
    <div data-testid="queue" data-profile={String(props.profileId)} />
  ),
}))

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "ssh:prod-web-01",
    kind: "ssh-host",
    label: "prod-web-01",
    isSelf: false,
    baseUrl: "ssh://deploy@prod:22",
    adminState: "unknown",
    reachability: "offline",
    liveness: { online: false, lastSeenAt: 0, source: "manifest" },
    capabilities: [],
    capabilityReportMissing: true,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: 0 },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  } as DeviceRow
}

beforeEach(() => {
  reach = { available: true }
})

describe("sshProfileIdFrom", () => {
  it("reads the profile out of the row reference, and refuses anything else", () => {
    expect(sshProfileIdFrom("ssh:prod-web-01")).toBe("prod-web-01")
    expect(sshProfileIdFrom("device:phone-a")).toBeNull()
  })
})

describe("FilesSection", () => {
  it("hands both panels the machine the row names", () => {
    render(<FilesSection row={row()} />)
    expect(screen.getByTestId("browser")).toHaveAttribute("data-profile", "prod-web-01")
    expect(screen.getByTestId("queue")).toHaveAttribute("data-profile", "prod-web-01")
  })

  /**
   * The section renders whether or not it can run. Hiding it would collapse
   * three different answers into one silence: no host at all, a host that
   * cannot open a shell, and a missing grant. Only the first is fixed by
   * pairing, so only saying which one is useful.
   */
  it("renders the reason rather than disappearing when it cannot run here", () => {
    reach = { available: false }
    render(<FilesSection row={row()} />)
    expect(screen.getByTestId("files-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("browser")).not.toBeInTheDocument()
  })

  it("says so when the row does not name a saved host", () => {
    render(<FilesSection row={row({ ref: "device:phone-a" })} />)
    expect(screen.getByTestId("files-unknown-profile")).toBeInTheDocument()
  })
})
