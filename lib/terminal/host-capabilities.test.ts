/**
 * @jest-environment jsdom
 */

let mockChain: string[] = []
const mockDescribeHost = jest.fn(async () => {})

jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

jest.mock("./transport-ws", () => ({
  RemoteTerminalSession: {
    describeHost: (...args: unknown[]) => mockDescribeHost(...(args as [])),
  },
}))

import {
  __resetHostCapabilitiesForTests,
  ensureHostCapabilities,
  getHostCapabilities,
  parseHostCapabilities,
  recordHostCapabilities,
  subscribeHostCapabilities,
} from "./host-capabilities"

const HOST = {
  platform: "linux",
  defaultShell: "/bin/bash",
  availableShells: [
    { path: "/bin/bash", kind: "bash" },
    { path: "/bin/sh", kind: "sh" },
  ],
  homeDir: "/root",
}

beforeEach(() => {
  __resetHostCapabilitiesForTests()
  mockChain = []
  mockDescribeHost.mockReset()
  mockDescribeHost.mockResolvedValue(undefined)
})

describe("parseHostCapabilities", () => {
  it("accepts a complete description", () => {
    expect(parseHostCapabilities(HOST)).toEqual(HOST)
  })

  // A blank default shell would be handed straight to the host as the shell to
  // spawn, and the caller cannot tell it apart from a deliberate choice.
  it("rejects a description with no usable default shell", () => {
    expect(parseHostCapabilities({ ...HOST, defaultShell: "   " })).toBeNull()
    expect(parseHostCapabilities({ ...HOST, defaultShell: 42 })).toBeNull()
  })

  it("rejects a platform outside the shared vocabulary", () => {
    expect(parseHostCapabilities({ ...HOST, platform: "plan9" })).toBeNull()
  })

  it("drops malformed shell entries rather than the whole description", () => {
    const parsed = parseHostCapabilities({
      ...HOST,
      availableShells: [{ path: "/bin/bash" }, { path: "" }, null, { kind: "zsh" }],
    })
    expect(parsed?.availableShells).toEqual([{ path: "/bin/bash", kind: "unknown" }])
  })

  it("ignores junk", () => {
    expect(parseHostCapabilities(undefined)).toBeNull()
    expect(parseHostCapabilities("nope")).toBeNull()
  })
})

describe("recordHostCapabilities", () => {
  it("publishes the host and notifies subscribers", () => {
    const listener = jest.fn()
    subscribeHostCapabilities(listener)
    recordHostCapabilities(HOST)
    expect(getHostCapabilities()).toEqual(HOST)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  // Every list frame carries the description, and the reattach path lists on
  // every boot; re-notifying on an unchanged host would re-render the picker
  // and the spawn path for nothing.
  it("does not notify when the host has not changed", () => {
    recordHostCapabilities(HOST)
    const listener = jest.fn()
    subscribeHostCapabilities(listener)
    recordHostCapabilities({ ...HOST })
    expect(listener).not.toHaveBeenCalled()
  })

  it("notifies when the host answers differently", () => {
    recordHostCapabilities(HOST)
    const listener = jest.fn()
    subscribeHostCapabilities(listener)
    recordHostCapabilities({ ...HOST, defaultShell: "/bin/zsh" })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getHostCapabilities()?.defaultShell).toBe("/bin/zsh")
  })

  it("leaves the cache alone when handed junk", () => {
    recordHostCapabilities(HOST)
    recordHostCapabilities({ platform: "linux" })
    expect(getHostCapabilities()).toEqual(HOST)
  })
})

describe("ensureHostCapabilities", () => {
  it("returns the cache without probing when it is warm", async () => {
    recordHostCapabilities(HOST)
    await expect(ensureHostCapabilities()).resolves.toEqual(HOST)
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  // The local PTY *is* the host: `shell-detect` already describes it, and a
  // remote probe there would be nonsense.
  it("never probes on the local PTY", async () => {
    mockChain = ["tauri-channel"]
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  it("returns null without probing in web standalone", async () => {
    mockChain = []
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    expect(mockDescribeHost).not.toHaveBeenCalled()
  })

  it("probes the host over a remote transport", async () => {
    mockChain = ["ws", "webrtc"]
    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(HOST)
    })
    await expect(ensureHostCapabilities()).resolves.toEqual(HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(1)
  })

  // The dock's "+ New" and the shell picker opening together must not each pay
  // a socket ticket and a WebSocket.
  it("shares one probe between concurrent callers", async () => {
    mockChain = ["ws"]
    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(HOST)
    })
    const [a, b] = await Promise.all([ensureHostCapabilities(), ensureHostCapabilities()])
    expect(a).toEqual(HOST)
    expect(b).toEqual(HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(1)
  })

  // Callers are on the spawn path: a failed probe must degrade to the caller's
  // own guess, not take the spawn down.
  it("swallows a failed probe and reports an unknown host", async () => {
    mockChain = ["ws"]
    mockDescribeHost.mockRejectedValue(new Error("unpaired"))
    await expect(ensureHostCapabilities()).resolves.toBeNull()
  })

  it("retries after a failed probe rather than caching the failure", async () => {
    mockChain = ["ws"]
    mockDescribeHost.mockRejectedValueOnce(new Error("host offline"))
    await expect(ensureHostCapabilities()).resolves.toBeNull()
    mockDescribeHost.mockImplementation(async () => {
      recordHostCapabilities(HOST)
    })
    await expect(ensureHostCapabilities()).resolves.toEqual(HOST)
    expect(mockDescribeHost).toHaveBeenCalledTimes(2)
  })
})
