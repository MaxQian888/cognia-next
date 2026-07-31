import { act, renderHook } from "@testing-library/react"
import { useSessionImportWatch, type UseSessionImportWatchDeps } from "./use-session-import-watch"

type ChangedHandler = (event: { payload?: { path?: string } }) => void

function makeDeps(over: Partial<UseSessionImportWatchDeps> = {}) {
  let handler: ChangedHandler | null = null
  const unlisten = jest.fn()
  const deps: UseSessionImportWatchDeps = {
    isTauri: jest.fn(() => true),
    invoke: jest.fn(async () => true) as unknown as UseSessionImportWatchDeps["invoke"],
    listen: jest.fn(async (_event: string, cb: ChangedHandler) => {
      handler = cb
      return unlisten
    }) as unknown as UseSessionImportWatchDeps["listen"],
    collectWatchRoots: jest.fn(async () => ["/home/u/.claude/projects"]),
    runWatchImport: jest.fn(async () => ({ sessions: 0, messages: 0 })),
    ...over,
  }
  return { deps, fire: (path?: string) => handler?.({ payload: { path } }), unlisten }
}

describe("useSessionImportWatch", () => {
  it("is a no-op off Tauri", async () => {
    const { deps } = makeDeps({ isTauri: jest.fn(() => false) })
    const { result } = renderHook(() => useSessionImportWatch({ deps }))
    await act(async () => {
      await result.current.toggle(true)
    })
    expect(result.current.enabled).toBe(false)
    expect(deps.invoke).not.toHaveBeenCalled()
  })

  it("starts the watcher, imports on change, and stops cleanly", async () => {
    const { deps, fire, unlisten } = makeDeps()
    const { result } = renderHook(() => useSessionImportWatch({ projectId: "proj", deps }))

    await act(async () => {
      await result.current.toggle(true)
    })
    expect(result.current.enabled).toBe(true)
    expect(deps.invoke).toHaveBeenCalledWith("session_import_watch_start", {
      roots: ["/home/u/.claude/projects"],
    })

    // A change event triggers a scoped background re-import.
    await act(async () => {
      fire("/home/u/.claude/projects/x.jsonl")
    })
    expect(deps.runWatchImport).toHaveBeenCalledWith({
      changedPath: "/home/u/.claude/projects/x.jsonl",
      projectId: "proj",
    })

    await act(async () => {
      await result.current.toggle(false)
    })
    expect(result.current.enabled).toBe(false)
    expect(unlisten).toHaveBeenCalled()
    expect(deps.invoke).toHaveBeenCalledWith("session_import_watch_stop")
  })
})
