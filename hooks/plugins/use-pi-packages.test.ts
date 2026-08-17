/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { PiPackagesSnapshot } from "@/lib/pi-packages/host"
import { usePiPackages } from "./use-pi-packages"

jest.mock("@/lib/pi-packages/host", () => ({
  loadPiPackages: jest.fn(),
  runPiMutation: jest.fn(),
  setPiPackageEnabled: jest.fn(),
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: mockProjects, activeProjectId: mockActiveProjectId }),
}))

let mockProjects: Array<{ id: string; roots: Array<{ path: string; primary?: boolean }> }> = []
let mockActiveProjectId: string | null = null

const host = jest.requireMock("@/lib/pi-packages/host") as {
  loadPiPackages: jest.Mock
  runPiMutation: jest.Mock
  setPiPackageEnabled: jest.Mock
}

function snapshot(partial: Partial<PiPackagesSnapshot> = {}): PiPackagesSnapshot {
  return {
    user: { packages: [], unparseable: false, missing: false, warnings: [] },
    project: { packages: [], unparseable: false, missing: true, warnings: [] },
    cli: { available: true, version: "0.84.1" },
    projectCwd: null,
    userBaseDir: "/home/u/.pi/agent",
    ...partial,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockProjects = []
  mockActiveProjectId = null
  host.loadPiPackages.mockResolvedValue(snapshot())
  host.runPiMutation.mockResolvedValue({ ok: true, plan: { strategy: "pi-cli" } })
  host.setPiPackageEnabled.mockResolvedValue({ ok: true })
})

describe("usePiPackages", () => {
  it("loads on mount and clears loading", async () => {
    const { result } = renderHook(() => usePiPackages())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot).not.toBeNull()
  })

  it("passes no cwd when no workspace is active", async () => {
    renderHook(() => usePiPackages())
    await waitFor(() => expect(host.loadPiPackages).toHaveBeenCalled())
    expect(host.loadPiPackages).toHaveBeenCalledWith(null)
  })

  it("passes the active workspace's primary root as the cwd", async () => {
    mockProjects = [{ id: "p1", roots: [{ path: "/repo", primary: true }] }]
    mockActiveProjectId = "p1"
    renderHook(() => usePiPackages())
    await waitFor(() => expect(host.loadPiPackages).toHaveBeenCalledWith("/repo"))
  })

  it("exposes the project settings path a project write would touch", async () => {
    mockProjects = [{ id: "p1", roots: [{ path: "/repo", primary: true }] }]
    mockActiveProjectId = "p1"
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.projectPath).toBe("/repo/.pi/settings.json"))
  })

  /**
   * The whole point of the hook: the two scopes stay separate and are merged by
   * Pi's rule, so a project entry does not silently erase the user's list.
   */
  it("keeps user packages when the project declares an unrelated one", async () => {
    host.loadPiPackages.mockResolvedValue(
      snapshot({
        user: { packages: ["npm:a", "npm:b"], unparseable: false, missing: false, warnings: [] },
        project: { packages: ["npm:c"], unparseable: false, missing: false, warnings: [] },
        projectCwd: "/repo",
      })
    )
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.resolved).toHaveLength(3))
    expect(result.current.resolved.map((r) => r.identity).sort()).toEqual([
      "npm:a",
      "npm:b",
      "npm:c",
    ])
  })

  it("computes the budget from real catalog entries", async () => {
    host.loadPiPackages.mockResolvedValue(
      snapshot({
        user: {
          packages: ["npm:pi-memory@0.4.2"],
          unparseable: false,
          missing: false,
          warnings: [],
        },
      })
    )
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.budget.toolCount).toBe(7))
  })

  it("reports overlaps between two packages in the same group", async () => {
    host.loadPiPackages.mockResolvedValue(
      snapshot({
        user: {
          packages: ["npm:pi-memory@0.4.2", "npm:@vtstech/pi-long-term-memory@1.3.5"],
          unparseable: false,
          missing: false,
          warnings: [],
        },
      })
    )
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.overlaps).toHaveLength(1))
    expect(result.current.overlaps[0].group).toBe("memory")
  })

  it("reports discouraged packages", async () => {
    host.loadPiPackages.mockResolvedValue(
      snapshot({
        user: {
          packages: ["npm:pi-finish-notification@1.0.4"],
          unparseable: false,
          missing: false,
          warnings: [],
        },
      })
    )
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.discouraged).toHaveLength(1))
  })

  it("flags Pi as missing when the user settings file is absent", async () => {
    host.loadPiPackages.mockResolvedValue(
      snapshot({ user: { packages: [], unparseable: false, missing: true, warnings: [] } })
    )
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.piMissing).toBe(true))
  })

  it("collects warnings from both scopes", async () => {
    host.loadPiPackages.mockResolvedValue(
      snapshot({
        user: { packages: [], unparseable: false, missing: false, warnings: ["u"] },
        project: { packages: [], unparseable: false, missing: false, warnings: ["p"] },
      })
    )
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.warnings).toEqual(["u", "p"]))
  })

  it("reloads after a successful mutation", async () => {
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.loading).toBe(false))
    host.loadPiPackages.mockClear()
    await act(async () => {
      await result.current.mutate({ kind: "install", spec: "npm:a", scope: "user" })
    })
    expect(host.loadPiPackages).toHaveBeenCalledTimes(1)
  })

  it("does not reload after a failed mutation", async () => {
    host.runPiMutation.mockResolvedValue({ ok: false, plan: { strategy: "pi-cli" }, error: "boom" })
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.loading).toBe(false))
    host.loadPiPackages.mockClear()
    await act(async () => {
      await result.current.mutate({ kind: "install", spec: "npm:a", scope: "user" })
    })
    expect(host.loadPiPackages).not.toHaveBeenCalled()
  })

  it("forwards the detected CLI availability into the mutation", async () => {
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.mutate({ kind: "install", spec: "npm:a", scope: "user" })
    })
    expect(host.runPiMutation).toHaveBeenCalledWith(
      { kind: "install", spec: "npm:a", scope: "user" },
      { cwd: null, cli: { available: true, version: "0.84.1" } }
    )
  })

  it("reloads after a successful enable toggle", async () => {
    const { result } = renderHook(() => usePiPackages())
    await waitFor(() => expect(result.current.loading).toBe(false))
    host.loadPiPackages.mockClear()
    await act(async () => {
      await result.current.setEnabled("npm:a", "user", false)
    })
    expect(host.setPiPackageEnabled).toHaveBeenCalledWith("npm:a", "user", false, { cwd: null })
    expect(host.loadPiPackages).toHaveBeenCalledTimes(1)
  })
})
