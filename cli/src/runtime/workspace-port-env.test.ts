/** @jest-environment node */
import { isHeadlessHost } from "@/lib/platform/detect"
import { resolveWorkspacePortLeaseEnsure } from "@/lib/task-workspace/client"
import type { WorkspacePortLease } from "@/lib/task-workspace/types"
import { resolveWorkspacePortEnv } from "./workspace-port-env"

jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: jest.fn() }))
jest.mock("@/lib/task-workspace/client", () => ({ resolveWorkspacePortLeaseEnsure: jest.fn() }))

const isHeadless = jest.mocked(isHeadlessHost)
const resolveLease = jest.mocked(resolveWorkspacePortLeaseEnsure)

describe("CLI trusted workspace port env", () => {
  beforeEach(() => {
    jest.resetAllMocks()
    isHeadless.mockReturnValue(true)
  })

  it("gets env for fresh checkouts from host ensure without frontend registration", async () => {
    resolveLease
      .mockResolvedValueOnce({ basePort: 41000, portCount: 10 } as WorkspacePortLease)
      .mockResolvedValueOnce({ basePort: 41010, portCount: 10 } as WorkspacePortLease)
    await expect(resolveWorkspacePortEnv("/work/one")).resolves.toEqual({
      COGNIA_PORT: "41000",
      COGNIA_PORT_COUNT: "10",
      PORT: "41000",
    })
    await expect(resolveWorkspacePortEnv("/work/two")).resolves.toEqual({
      COGNIA_PORT: "41010",
      COGNIA_PORT_COUNT: "10",
      PORT: "41010",
    })
    expect(resolveLease.mock.calls).toEqual([
      ["/work/one", undefined, "host-loopback"],
      ["/work/two", undefined, "host-loopback"],
    ])
  })

  it("returns no overlay without a host or matching subject", async () => {
    isHeadless.mockReturnValue(false)
    await expect(resolveWorkspacePortEnv("/standalone")).resolves.toEqual({})
    expect(resolveLease).not.toHaveBeenCalled()
    isHeadless.mockReturnValue(true)
    resolveLease.mockResolvedValue(null)
    await expect(resolveWorkspacePortEnv("/unregistered")).resolves.toEqual({})
  })

  it("uses the discovered checkout block when execution starts in a subdirectory", async () => {
    resolveLease.mockResolvedValue({
      subjectKind: "project-root",
      subjectKey: "root:/fresh-checkout",
      canonicalRoot: "/fresh-checkout",
      basePort: 41020,
      portCount: 10,
    } as WorkspacePortLease)
    await expect(resolveWorkspacePortEnv("/fresh-checkout/src")).resolves.toEqual({
      COGNIA_PORT: "41020",
      COGNIA_PORT_COUNT: "10",
      PORT: "41020",
    })
    expect(resolveLease).toHaveBeenCalledWith("/fresh-checkout/src", undefined, "host-loopback")
  })

  it("preserves host allocation errors instead of falling back", async () => {
    resolveLease.mockRejectedValue(new Error("portRangeStart: range exhausted"))
    await expect(resolveWorkspacePortEnv("/work")).rejects.toThrow(
      "portRangeStart: range exhausted"
    )
  })
})
