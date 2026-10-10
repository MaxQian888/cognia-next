/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/hooks/filespace/use-conversation-filespace", () => ({
  useConversationFileSpace: jest.fn(),
}))

import { useConversationFileSpace } from "@/hooks/filespace/use-conversation-filespace"
import type { ExpandedShareSelection } from "@/lib/share/file-selection"
import type { FileSpacePath } from "@/types/filespace"

import { useShareFileSelection } from "./use-share-file-selection"

const useSpace = useConversationFileSpace as jest.Mock
const SPACE = { sessionId: "s1", status: "available", mounts: [], hostId: "local" }
const LOADED = { space: SPACE, dexie: { uploads: [], artifacts: [] } }

function expansion(paths: string[]): ExpandedShareSelection {
  return {
    files: paths.map((path) => ({
      path: path as FileSpacePath,
      name: path,
      mime: "text/plain",
      size: 1,
      sensitive: false,
      open: jest.fn(),
    })),
    skippedSensitive: 0,
    truncated: false,
    issues: [],
  }
}

beforeEach(() => useSpace.mockReturnValue(LOADED))

describe("useShareFileSelection", () => {
  it("is an empty, settled selection until something is ticked", () => {
    const expand = jest.fn()
    const { result } = renderHook(() => useShareFileSelection("s1", [], expand))
    expect(result.current).toMatchObject({ pending: false, failed: false })
    expect(result.current.expanded?.files).toEqual([])
    expect(expand).not.toHaveBeenCalled()
  })

  it("expands the selection against the conversation's FileSpace", async () => {
    const expand = jest.fn(async (_space: unknown, paths: readonly FileSpacePath[]) =>
      expansion([...paths])
    )
    const { result } = renderHook(() =>
      useShareFileSelection("s1", ["/workspace/a" as FileSpacePath], expand)
    )
    expect(result.current.pending).toBe(true)
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(expand).toHaveBeenCalledWith(SPACE, ["/workspace/a"])
    expect(result.current.expanded?.files.map((f) => f.path)).toEqual(["/workspace/a"])
  })

  it("drops an expansion a newer selection overtook", async () => {
    let releaseFirst: (value: ExpandedShareSelection) => void = () => {}
    const expand = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<ExpandedShareSelection>((resolve) => (releaseFirst = resolve))
      )
      .mockImplementationOnce(async () => expansion(["/b"]))
    const { result, rerender } = renderHook(
      ({ selected }) => useShareFileSelection("s1", selected, expand),
      { initialProps: { selected: ["/a" as FileSpacePath] } }
    )
    rerender({ selected: ["/b" as FileSpacePath] })
    await waitFor(() => expect(result.current.expanded?.files[0]?.path).toBe("/b"))
    await act(async () => releaseFirst(expansion(["/a"])))
    expect(result.current.expanded?.files[0]?.path).toBe("/b")
  })

  it("reports a failed expansion", async () => {
    const expand = jest.fn(async () => {
      throw new Error("host offline")
    })
    const { result } = renderHook(() =>
      useShareFileSelection("s1", ["/x" as FileSpacePath], expand)
    )
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.pending).toBe(false)
    expect(result.current.expanded).toBeNull()
  })

  it("waits for the FileSpace before expanding", () => {
    useSpace.mockReturnValue(undefined)
    const expand = jest.fn()
    const { result } = renderHook(() =>
      useShareFileSelection("s1", ["/x" as FileSpacePath], expand)
    )
    expect(result.current.pending).toBe(true)
    expect(expand).not.toHaveBeenCalled()
  })
})
