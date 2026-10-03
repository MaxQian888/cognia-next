import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"

import { __configureRootWatchersForTesting, watchedRoots, watchRoot } from "./root-watchers"

describe("root watchers", () => {
  const emit = new Map<string, (change: WorkspaceFsChange) => void>()
  const stopped: string[] = []
  beforeEach(() => {
    emit.clear()
    stopped.length = 0
    __configureRootWatchersForTesting((root, onChange) => {
      emit.set(root, onChange)
      return () => stopped.push(root)
    })
  })
  afterAll(() => __configureRootWatchersForTesting(null))

  it("shares one watch per folder and stops it with the last listener", () => {
    const a = jest.fn()
    const b = jest.fn()
    const offA = watchRoot("/repo/", a)
    const offB = watchRoot("/repo", b)
    expect(watchedRoots()).toEqual(["/repo"])
    emit.get("/repo")!({ kind: "modify", path: "C:\\repo\\x" })
    expect(a).toHaveBeenCalledWith({ kind: "modify", path: "C:/repo/x" })
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offA()
    expect(stopped).toEqual([])
    offB()
    expect(stopped).toEqual(["/repo"])
    expect(watchedRoots()).toEqual([])
  })
})
