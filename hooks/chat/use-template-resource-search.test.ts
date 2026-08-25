/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import { useTemplateResourceSearch } from "./use-template-resource-search"

const searchWorkspace = jest.fn()
jest.mock("@/lib/files/workspace-search", () => ({
  searchWorkspace: (...args: unknown[]) => searchWorkspace(...args),
}))

const agents = [
  { handle: "reviewer", name: "Reviewer", description: "reviews" },
  { handle: "writer", name: "Writer", description: "writes" },
] as never[]

describe("useTemplateResourceSearch", () => {
  beforeEach(() => {
    searchWorkspace.mockReset()
  })

  it("spells a file exactly as the @ menu would", async () => {
    searchWorkspace.mockResolvedValue([
      { relPath: "src/app.ts", absolutePath: "/r/src/app.ts", isDir: false },
      { relPath: "src/lib", absolutePath: "/r/src/lib", isDir: true },
    ])
    const { result } = renderHook(() => useTemplateResourceSearch({ cwd: "/r" }))
    const options = await result.current("file", "src")
    expect(options).toEqual([
      { id: "src/app.ts", label: "src/app.ts", raw: "@src/app.ts" },
      // The trailing slash is the mention handler's, not ours.
      { id: "src/lib", label: "src/lib", raw: "@src/lib/" },
    ])
  })

  it("returns nothing rather than failing when there is no workspace", async () => {
    const { result } = renderHook(() => useTemplateResourceSearch({ cwd: null }))
    expect(await result.current("file", "x")).toEqual([])
    expect(searchWorkspace).not.toHaveBeenCalled()
  })

  it("swallows a failed workspace search", async () => {
    searchWorkspace.mockRejectedValue(new Error("not a directory"))
    const { result } = renderHook(() => useTemplateResourceSearch({ cwd: "/r" }))
    expect(await result.current("file", "x")).toEqual([])
  })

  it("binds a subagent to its handle and shows its name", async () => {
    const { result } = renderHook(() =>
      useTemplateResourceSearch({ cwd: null, chatAgents: agents })
    )
    const options = await result.current("subagent", "rev")
    expect(options).toEqual([{ id: "reviewer", label: "Reviewer", raw: "@reviewer" }])
  })

  it("offers nothing for a kind this composer has no source for", async () => {
    const { result } = renderHook(() => useTemplateResourceSearch({ cwd: null }))
    expect(await result.current("agent", "")).toEqual([])
  })
})
