/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { Project } from "@/types"

const projects: Array<Pick<Project, "id" | "roots">> = [
  { id: "p1", roots: [{ id: "r1", path: "/repos/app", isPrimary: true }] } as never,
]
let trustEnabled = true

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector({ projects }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { workspaceTrust: { enabled: trustEnabled } } }),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import { useRepoWorkspaceConfig } from "./use-repo-workspace-config"
import { parseWorkspaceConfig } from "@/lib/project-environment/workspace-config"
import { workspaceConfigDigest } from "@/lib/project-environment/workspace-config-trust"

const CONFIG = { version: 1, setup: { default: "pnpm install" } }

function deps(over: Record<string, unknown> = {}) {
  return {
    readFile: jest.fn(async () => JSON.stringify(CONFIG)),
    isRestricted: jest.fn(async () => false),
    approvedDigestFor: jest.fn(async () => undefined),
    approve: jest.fn(async () => true),
    ...over,
  }
}

beforeEach(() => {
  trustEnabled = true
})

describe("useRepoWorkspaceConfig", () => {
  it("reports a pending approval and the configuration behind it", async () => {
    const { result } = renderHook(() => useRepoWorkspaceConfig("p1", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.verdict.kind).toBe("unapproved")
    expect(result.current.approvalKey).toBe("/repos/app")
  })

  it("records the approval against the workspace's primary root", async () => {
    const digest = await workspaceConfigDigest(parseWorkspaceConfig(JSON.stringify(CONFIG)))
    const approve = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p1", "/repos/.wt/feature", deps({ approve }))
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.approve()
    })
    expect(approve).toHaveBeenCalledWith("/repos/app", digest)
  })

  it("re-reads after approving instead of assuming it worked", async () => {
    // The file can change between the render and the click; claiming an
    // approval the gate would not agree with is the whole failure this exists
    // to prevent.
    const approvedDigestFor = jest.fn(async () => undefined)
    const d = deps({ approvedDigestFor })
    const { result } = renderHook(() => useRepoWorkspaceConfig("p1", "/repos/app", d))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = approvedDigestFor.mock.calls.length
    await act(async () => {
      await result.current.approve()
    })
    await waitFor(() => expect(approvedDigestFor.mock.calls.length).toBeGreaterThan(before))
  })

  it("refuses to approve anything but a pending verdict", async () => {
    const approve = jest.fn(async () => true)
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig(
        "p1",
        "/repos/app",
        deps({ approve, isRestricted: jest.fn(async () => true) })
      )
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("restricted"))
    await act(async () => {
      await result.current.approve()
    })
    expect(approve).not.toHaveBeenCalled()
  })

  it("surfaces a read failure as invalid rather than as no configuration", async () => {
    const { result } = renderHook(() =>
      useRepoWorkspaceConfig("p1", "/repos/app", deps({ readFile: jest.fn(async () => "{{{") }))
    )
    await waitFor(() => expect(result.current.verdict.kind).toBe("invalid"))
  })

  it("re-reads when the execution root moves", async () => {
    const readFile = jest.fn(async () => JSON.stringify(CONFIG))
    const d = deps({ readFile })
    const { rerender, result } = renderHook(
      ({ root }: { root: string }) => useRepoWorkspaceConfig("p1", root, d),
      { initialProps: { root: "/repos/app" } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    const first = readFile.mock.calls.length
    rerender({ root: "/repos/.wt/feature" })
    await waitFor(() => expect(readFile.mock.calls.length).toBeGreaterThan(first))
  })

  it("has no approval key for a workspace it cannot find", async () => {
    const { result } = renderHook(() => useRepoWorkspaceConfig("gone", "/repos/app", deps()))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.approvalKey).toBeNull()
  })
})
