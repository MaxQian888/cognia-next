import { render, screen } from "@testing-library/react"

import { HostsTab } from "./hosts-tab"

let hosts: { id: string; label: string; featureManifest?: unknown }[] = []
let activeHostId: string | null = null

jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (state: unknown) => unknown) => selector({ hosts, activeHostId }),
}))

beforeEach(() => {
  hosts = []
  activeHostId = null
})

describe("HostsTab", () => {
  /**
   * The list moved to `/devices`. What stays is the count and the way in —
   * keeping a second list here would mean two surfaces to hold in step, and
   * the one in Settings is the one that would fall behind.
   */
  it("counts the configured hosts instead of listing them", () => {
    hosts = [
      { id: "h1", label: "Build box" },
      { id: "h2", label: "Cloud" },
    ]
    render(<HostsTab />)
    expect(screen.getByTestId("device-console-link-hosts")).toBeInTheDocument()
    expect(screen.getByText(/2 hosts are configured/)).toBeInTheDocument()
    expect(screen.queryByText("Build box")).not.toBeInTheDocument()
  })

  it("says plainly when nothing is configured", () => {
    render(<HostsTab />)
    expect(screen.getByText(/No hosts are configured/)).toBeInTheDocument()
  })

  it("links into the console without preselecting anything when nothing is active", () => {
    hosts = [{ id: "h1", label: "Build box" }]
    render(<HostsTab />)
    expect(screen.getByRole("link", { name: /Open device console/ })).toHaveAttribute(
      "href",
      "/devices"
    )
  })

  it("lands on the host being driven, which is the row a reader means", () => {
    hosts = [{ id: "h1", label: "Build box" }]
    activeHostId = "h1"
    render(<HostsTab />)
    expect(screen.getByRole("link", { name: /Open device console/ })).toHaveAttribute(
      "href",
      "/devices?device=host%3Ah1"
    )
  })

  /**
   * A probed host is addressed by the identity it published, so a hand-built
   * `host:<storeId>` would simply not match any row in the console.
   */
  it("addresses a probed host by its published identity", () => {
    hosts = [
      {
        id: "h1",
        label: "Build box",
        featureManifest: {
          schemaVersion: 2,
          hostIdentity: { id: "published-id", kind: "desktop" },
        },
      },
    ]
    activeHostId = "h1"
    render(<HostsTab />)
    expect(screen.getByRole("link", { name: /Open device console/ })).toHaveAttribute(
      "href",
      "/devices?device=published-id"
    )
  })
})
