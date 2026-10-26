/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"
import { useProjectStore } from "@/stores/project/project-store"
import { usePromptResourceContext } from "./use-prompt-resource-context"

beforeEach(() => {
  useProjectStore.setState({
    activeProjectId: "ws-2",
    projects: [
      { id: "ws-1", name: "Repo", customInstructions: "Use pnpm.", roots: [{ path: "/repo" }] },
      { id: "ws-2", name: "Other", roots: [] },
    ],
  } as never)
})

it("describes the named workspace, not the active one", () => {
  const { result } = renderHook(() => usePromptResourceContext("ws-1"))
  expect(result.current).toEqual({
    workspace: { id: "ws-1", name: "Repo", roots: ["/repo"], customInstructions: "Use pnpm." },
  })
})

it("is empty without a workspace or for an unknown one", () => {
  expect(renderHook(() => usePromptResourceContext(null)).result.current).toEqual({})
  expect(renderHook(() => usePromptResourceContext("gone")).result.current).toEqual({})
})

it("keeps its identity across renders while the workspace is unchanged", () => {
  const { result, rerender } = renderHook(() => usePromptResourceContext("ws-1"))
  const first = result.current
  rerender()
  expect(result.current).toBe(first)
})
