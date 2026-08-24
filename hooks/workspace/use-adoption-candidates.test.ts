/** @jest-environment jsdom */

const listWorkspaceEnvironments = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspaceEnvironments: () => listWorkspaceEnvironments(),
}))

import { act, renderHook, waitFor } from "@testing-library/react"

import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { useAdoptionCandidates } from "./use-adoption-candidates"

function seedStores(options: { roots?: string[]; terminalCwds?: (string | null)[] }) {
  useProjectStore.setState({
    projects: (options.roots ?? []).map((path, index) => ({
      id: `w${index}`,
      name: `w${index}`,
      roots: [{ id: `r${index}`, path, isPrimary: true }],
    })),
  } as unknown as Parameters<typeof useProjectStore.setState>[0])

  useTerminalStore.setState({
    sessions: Object.fromEntries(
      (options.terminalCwds ?? []).map((cwd, index) => [`t${index}`, { id: `t${index}`, cwd }])
    ),
  } as unknown as Parameters<typeof useTerminalStore.setState>[0])
}

beforeEach(() => {
  localStorage.clear()
  listWorkspaceEnvironments.mockReset()
  listWorkspaceEnvironments.mockResolvedValue([])
})

it("offers a terminal cwd that no workspace owns", async () => {
  seedStores({ roots: ["/src/app"], terminalCwds: ["/work/site"] })
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates.map((c) => c.path)).toEqual(["/work/site"])
})

it("does not offer a cwd inside an existing workspace", async () => {
  seedStores({ roots: ["/src/app"], terminalCwds: ["/src/app/lib"] })
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates).toEqual([])
})

it("offers a worktree's source repository, not the worktree itself", async () => {
  // Adopting `.cognia/worktrees/<id>` would create the duplicate entity that
  // adoption exists to remove.
  listWorkspaceEnvironments.mockResolvedValue([
    { environmentId: "e1", path: "/src/app/.cognia/worktrees/e1", sourceRoot: "/repos/api" },
  ])
  seedStores({})
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates.map((c) => c.path)).toEqual(["/repos/api"])
})

it("falls back to the row's own path when no source root was recorded", async () => {
  listWorkspaceEnvironments.mockResolvedValue([{ environmentId: "e1", path: "/repos/adopted" }])
  seedStores({})
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates.map((c) => c.path)).toEqual(["/repos/adopted"])
})

it("skips a registry row that already names its workspace", async () => {
  listWorkspaceEnvironments.mockResolvedValue([
    { environmentId: "e1", path: "/x", sourceRoot: "/repos/api", projectId: "w0" },
  ])
  seedStores({})
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates).toEqual([])
})

it("settles ready even when the registry is unreachable", async () => {
  // Browser shell, or the host is offline. A suggestion surface must not make
  // the switcher wait forever on it.
  listWorkspaceEnvironments.mockRejectedValue(new Error("no transport"))
  seedStores({ terminalCwds: ["/work/site"] })
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates.map((c) => c.path)).toEqual(["/work/site"])
})

it("ignores a terminal tab that has no cwd yet", async () => {
  seedStores({ terminalCwds: [null] })
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.candidates).toEqual([])
})

it("drops a dismissed path and remembers it on this device", async () => {
  seedStores({ terminalCwds: ["/work/site"] })
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.candidates).toHaveLength(1))

  act(() => result.current.dismiss("/work/site"))
  expect(result.current.candidates).toEqual([])

  const second = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(second.result.current.ready).toBe(true))
  expect(second.result.current.candidates).toEqual([])
})

it("re-collects on refresh", async () => {
  seedStores({})
  const { result } = renderHook(() => useAdoptionCandidates())
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(listWorkspaceEnvironments).toHaveBeenCalledTimes(1)

  listWorkspaceEnvironments.mockResolvedValue([{ environmentId: "e1", sourceRoot: "/repos/new" }])
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.candidates.map((c) => c.path)).toEqual(["/repos/new"]))
})
