import { render, screen } from "@testing-library/react"

import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { ItemOwner } from "@/types/placement/item-owner"

import { RunsOnHostBadge } from "./runs-on-host-badge"

const onMini: ItemOwner = {
  kind: "remote-host",
  hostId: "h1",
  hostLabel: "Mac mini",
  remoteItemId: "t1",
  operationId: "op",
  movedAt: 1,
}

describe("RunsOnHostBadge", () => {
  it("names the host and links to its always-on section", () => {
    render(<RunsOnHostBadge owner={onMini} />)
    const badge = screen.getByTestId("runs-on-host-badge")
    expect(badge).toHaveTextContent("Runs on Mac mini")
    expect(badge.getAttribute("href")).toBe("/devices?device=host%3Ah1&deviceSection=always-on")
  })

  it("addresses a host by the identity it published", () => {
    useRemoteHostStore.setState({
      hosts: [
        {
          id: "h1",
          label: "Mac mini",
          featureManifest: { schemaVersion: 2, hostIdentity: { id: "hid_42" } },
        } as never,
      ],
    })
    render(<RunsOnHostBadge owner={onMini} />)
    expect(screen.getByTestId("runs-on-host-badge").getAttribute("href")).toBe(
      "/devices?device=hid_42&deviceSection=always-on"
    )
  })

  it("is plain text inside another control", () => {
    render(<RunsOnHostBadge owner={onMini} link={false} />)
    const badge = screen.getByTestId("runs-on-host-badge")
    expect(badge.tagName).toBe("SPAN")
    expect(badge).toHaveTextContent("Runs on Mac mini")
  })

  it("renders nothing for an item that runs here", () => {
    const { container } = render(
      <RunsOnHostBadge owner={{ kind: "this-device", reason: "manual", pinnedAt: 1 }} />
    )
    expect(container).toBeEmptyDOMElement()
    render(<RunsOnHostBadge owner={undefined} />)
    expect(screen.queryByTestId("runs-on-host-badge")).toBeNull()
  })
})
