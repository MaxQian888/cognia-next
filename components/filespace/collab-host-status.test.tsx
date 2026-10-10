/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import type { CollabHostStatus } from "@/types/filespace/live"

import { CollabHostStatusBlock, readCollabHostProblem } from "./collab-host-status"

function status(overrides: Partial<CollabHostStatus> = {}): CollabHostStatus {
  return {
    sessionId: "s1",
    registration: {
      sessionId: "s1",
      orgId: "org_1",
      collabSessionId: "ses_1",
      serverUrl: "https://collab.test",
      hostLabel: "Studio Mac",
      registeredAt: 1,
      updatedAt: 1,
    },
    tokenPresent: true,
    running: true,
    lastContactAt: 2,
    lastError: null,
    unmirroredGrants: 0,
    ...overrides,
  }
}

function deps(current: CollabHostStatus | Error) {
  return {
    getStatus: jest.fn(async () => {
      if (current instanceof Error) throw current
      return current
    }),
    endHost: jest.fn(async () =>
      status({ registration: null, running: false, lastError: "unregistered" })
    ),
  }
}

beforeEach(() => jest.clearAllMocks())

describe("readCollabHostProblem", () => {
  it("names a known problem by its code and keeps the rest as text", () => {
    expect(readCollabHostProblem(null)).toBeNull()
    expect(readCollabHostProblem("host_unregistered")).toEqual({
      code: "host_unregistered",
      detail: "",
    })
    expect(readCollabHostProblem("org_policy: policy_live_disabled")).toEqual({
      code: "org_policy",
      detail: "policy_live_disabled",
    })
    expect(readCollabHostProblem("unreachable: connection refused")).toEqual({
      code: "unreachable",
      detail: "connection refused",
    })
    expect(readCollabHostProblem("the server URL is not valid")).toEqual({
      code: "other",
      detail: "the server URL is not valid",
    })
  })
})

describe("CollabHostStatusBlock", () => {
  it("says which host serves the members, and reads it on the conversation's host", async () => {
    const d = deps(status())
    render(
      <CollabHostStatusBlock
        sessionId="s1"
        hostId="host-a"
        refreshKey=""
        onEnded={jest.fn()}
        deps={d}
      />
    )
    expect(await screen.findByTestId("collab-host-status")).toHaveTextContent(
      "Members reach these files through Studio Mac."
    )
    expect(d.getStatus).toHaveBeenCalledWith("s1", { hostId: "host-a" })
  })

  it("says when the host is not answering, what has not reached the server, and why", async () => {
    render(
      <CollabHostStatusBlock
        sessionId="s1"
        refreshKey=""
        onEnded={jest.fn()}
        deps={deps(
          status({
            running: false,
            unmirroredGrants: 2,
            lastError: "unreachable: connection refused",
          })
        )}
      />
    )
    const block = await screen.findByTestId("collab-host-status")
    expect(block).toHaveTextContent("Studio Mac holds the members' shares but is not answering")
    expect(block).toHaveTextContent("2 shares have not reached the collaboration server yet")
    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not reach the collaboration server (connection refused)."
    )
  })

  it("renders nothing without a registration, unless the server dropped the host", async () => {
    const { container, unmount } = render(
      <CollabHostStatusBlock
        sessionId="s1"
        refreshKey=""
        onEnded={jest.fn()}
        deps={deps(status({ registration: null, running: false, lastError: "unregistered" }))}
      />
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    unmount()
    render(
      <CollabHostStatusBlock
        sessionId="s1"
        refreshKey=""
        onEnded={jest.fn()}
        deps={deps(status({ registration: null, running: false, lastError: "host_unregistered" }))}
      />
    )
    expect(await screen.findByTestId("collab-host-status")).toHaveTextContent(
      "no longer accepts this device"
    )
  })

  it("stops sharing with members after confirming, then reads the host again", async () => {
    const user = userEvent.setup()
    const d = deps(status())
    const onEnded = jest.fn()
    render(
      <CollabHostStatusBlock
        sessionId="s1"
        hostId="host-a"
        refreshKey=""
        onEnded={onEnded}
        deps={d}
      />
    )
    await user.click(await screen.findByRole("button", { name: "Stop sharing with members" }))
    expect(d.endHost).not.toHaveBeenCalled()
    await user.click(await screen.findByRole("button", { name: "Stop sharing" }))
    await waitFor(() => expect(d.endHost).toHaveBeenCalledWith({ id: "s1" }, { hostId: "host-a" }))
    await waitFor(() => expect(onEnded).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith("Stopped sharing with members")
    await waitFor(() => expect(d.getStatus).toHaveBeenCalledTimes(2))
  })

  it("says why stopping failed", async () => {
    const user = userEvent.setup()
    const d = deps(status())
    d.endHost.mockRejectedValue({ code: "collab_unreachable", message: "down", retryable: true })
    render(<CollabHostStatusBlock sessionId="s1" refreshKey="" onEnded={jest.fn()} deps={d} />)
    await user.click(await screen.findByRole("button", { name: "Stop sharing with members" }))
    await user.click(await screen.findByRole("button", { name: "Stop sharing" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("reads the host again when the grants change", async () => {
    const d = deps(status())
    const { rerender } = render(
      <CollabHostStatusBlock sessionId="s1" refreshKey="a" onEnded={jest.fn()} deps={d} />
    )
    await screen.findByTestId("collab-host-status")
    rerender(<CollabHostStatusBlock sessionId="s1" refreshKey="b" onEnded={jest.fn()} deps={d} />)
    await waitFor(() => expect(d.getStatus).toHaveBeenCalledTimes(2))
  })

  it("says when the host could not be read", async () => {
    render(
      <CollabHostStatusBlock
        sessionId="s1"
        refreshKey=""
        onEnded={jest.fn()}
        deps={deps(Object.assign(new Error("locked"), { code: "file_share_locked" }))}
      />
    )
    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })
})
