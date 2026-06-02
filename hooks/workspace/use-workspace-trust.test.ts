/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor, act } from "@testing-library/react"
import { useWorkspaceTrust } from "./use-workspace-trust"
import { useProjectStore } from "@/stores/project/project-store"
import * as trustDb from "@/lib/db/trusted-workspaces"
import * as tauri from "@/lib/tauri"

jest.mock("@/lib/db/trusted-workspaces")
jest.mock("@/lib/tauri")

const trusted = trustDb as jest.Mocked<typeof trustDb>

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: true })
  ;(tauri.isTauri as jest.Mock).mockReturnValue(true)
  trusted.isWorkspaceTrusted.mockResolvedValue(false)
  trusted.trustWorkspace.mockResolvedValue(undefined)
})

function seedActive(roots: { id: string; path: string; isPrimary?: boolean }[]) {
  const p = useProjectStore.getState().createProject({ name: "W", roots })
  act(() => useProjectStore.getState().setActiveProject(p.id))
  return p
}

it("restricted=false when no active workspace", async () => {
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.restricted).toBe(false))
})

it("restricted=false for a rootless workspace", async () => {
  seedActive([])
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.restricted).toBe(false))
})

it("restricted=true when a root is untrusted", async () => {
  seedActive([{ id: "r", path: "/a", isPrimary: true }])
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.restricted).toBe(true))
  expect(result.current.untrustedRoots.map((r) => r.path)).toEqual(["/a"])
})

it("restricted=false when every root is trusted", async () => {
  trusted.isWorkspaceTrusted.mockResolvedValue(true)
  seedActive([
    { id: "r1", path: "/a", isPrimary: true },
    { id: "r2", path: "/b" },
  ])
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.trustState["/a"]).toBe("trusted"))
  expect(result.current.restricted).toBe(false)
})

it("restricted=false on Web regardless of trust", async () => {
  ;(tauri.isTauri as jest.Mock).mockReturnValue(false)
  seedActive([{ id: "r", path: "/a", isPrimary: true }])
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.restricted).toBe(false))
})

it("trustAll trusts every untrusted root and flips restricted", async () => {
  seedActive([{ id: "r", path: "/a", isPrimary: true }])
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.restricted).toBe(true))
  trusted.isWorkspaceTrusted.mockResolvedValue(true)
  await act(async () => {
    await result.current.trustAll()
  })
  await waitFor(() => expect(result.current.restricted).toBe(false))
  expect(trusted.trustWorkspace).toHaveBeenCalledWith("/a")
})

it("trustRoot trusts a single path and refreshes", async () => {
  seedActive([
    { id: "r1", path: "/a", isPrimary: true },
    { id: "r2", path: "/b" },
  ])
  const { result } = renderHook(() => useWorkspaceTrust())
  await waitFor(() => expect(result.current.untrustedRoots).toHaveLength(2))
  await act(async () => {
    await result.current.trustRoot("/a")
  })
  expect(trusted.trustWorkspace).toHaveBeenCalledWith("/a")
})
