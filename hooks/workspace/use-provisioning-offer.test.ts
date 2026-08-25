/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { Project } from "@/types"

let mockProjects: Array<Partial<Project>> = []

// `mock`-prefixed so the hoisted `jest.mock` factory may close over it.
const mockUpdateProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ projects: mockProjects }),
    { getState: () => ({ projects: mockProjects, updateProject: mockUpdateProject }) }
  ),
}))

import { useProvisioningOffer } from "./use-provisioning-offer"

/** The repository root as the file bridge reports it, ignored entries included. */
const ALL = [
  { name: "package.json", isDir: false },
  { name: "pnpm-lock.yaml", isDir: false },
  { name: "node_modules", isDir: true },
  { name: ".env", isDir: false },
  { name: "src", isDir: true },
]
/** The same listing with `.gitignore` respected — the ignored ones are absent. */
const VISIBLE = ALL.filter((entry) => !["node_modules", ".env"].includes(entry.name))

function deps(over: Record<string, unknown> = {}) {
  return {
    listRoot: jest.fn(async (_root: string, includeIgnored: boolean) =>
      includeIgnored ? ALL : VISIBLE
    ),
    probePnpm: jest.fn(async () => "unsupported" as const),
    applyToWorkspace: mockUpdateProject,
    ...over,
  }
}

beforeEach(() => {
  mockProjects = [{ id: "p1" }]
  mockUpdateProject.mockClear()
})

describe("useProvisioningOffer", () => {
  it("derives the ignored set by subtracting the two listings", async () => {
    const { result } = renderHook(() => useProvisioningOffer("p1", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.candidates.map((candidate) => candidate.id)).toEqual([
      "cacheLink:node_modules",
      "include:.env",
    ])
    expect(result.current.pending).toHaveLength(2)
  })

  it("stops offering what the workspace already answered", async () => {
    mockProjects = [
      { id: "p1", workspaceProvisioning: { accepted: [], reviewed: ["include:.env"] } },
    ]
    const { result } = renderHook(() => useProvisioningOffer("p1", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pending.map((candidate) => candidate.id)).toEqual([
      "cacheLink:node_modules",
    ])
  })

  it("writes the decision onto the workspace row", async () => {
    const { result } = renderHook(() => useProvisioningOffer("p1", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.decide(["cacheLink:node_modules"], true))
    expect(mockUpdateProject).toHaveBeenCalledWith("p1", {
      workspaceProvisioning: {
        accepted: ["cacheLink:node_modules"],
        reviewed: ["cacheLink:node_modules"],
      },
    })
  })

  it("suppresses the node_modules share when pnpm already has a global store", async () => {
    const { result } = renderHook(() =>
      useProvisioningOffer("p1", "/repos/app", deps({ probePnpm: async () => "enabled" }))
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pnpm).toBe("enabled")
    expect(result.current.candidates.map((candidate) => candidate.id)).toEqual(["include:.env"])
  })

  it("proposes nothing and probes nothing without an execution root", async () => {
    const injected = deps()
    const { result } = renderHook(() => useProvisioningOffer("p1", null, injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.candidates).toEqual([])
    expect(injected.listRoot).not.toHaveBeenCalled()
    expect(injected.probePnpm).not.toHaveBeenCalled()
  })

  it("falls back to an empty offer when the listing fails", async () => {
    // A card that shows a stale proposal after the folder went away is worse
    // than one that shows none.
    const { result } = renderHook(() =>
      useProvisioningOffer(
        "p1",
        "/repos/app",
        deps({
          listRoot: async () => {
            throw new Error("ENOENT")
          },
        })
      )
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.candidates).toEqual([])
  })

  it("ignores a decision when the workspace is unknown", async () => {
    mockProjects = []
    const { result } = renderHook(() => useProvisioningOffer("missing", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.decide(["cacheLink:node_modules"], true))
    expect(mockUpdateProject).not.toHaveBeenCalled()
  })
})
