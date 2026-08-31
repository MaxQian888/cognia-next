/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

// `stores/index.ts` calls `isTauri()` at module top-level inside a Zustand
// `create()` factory during import hoisting — declare the mock inline.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(false),
}))

const renderSingleExportMock = jest.fn()
jest.mock("@/lib/export/single", () => ({
  renderSingleExport: (args: unknown) => renderSingleExportMock(args),
}))

const dbMessagesQuery = {
  where: jest.fn(),
  equals: jest.fn(),
  sortBy: jest.fn(),
}
dbMessagesQuery.where.mockReturnValue(dbMessagesQuery)
dbMessagesQuery.equals.mockReturnValue(dbMessagesQuery)
dbMessagesQuery.sortBy.mockResolvedValue([])

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ messages: dbMessagesQuery }),
}))

// The hook now delegates the platform write to the unified saver; mock it so
// these tests focus on the hook's orchestration (render → save → plugin hooks).
const saveExportMock = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (args: unknown) => saveExportMock(args),
}))
jest.mock("@/lib/twin/export-provenance", () => ({
  resolveSessionTwinProvenance: jest.fn(async () => undefined),
}))

import { useSingleExport } from "./use-single-export"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

const SAVED = {
  kind: "saved" as const,
  platform: "web" as const,
  location: "downloads",
  filename: "out.md",
}

beforeEach(() => {
  renderSingleExportMock.mockReset()
  saveExportMock.mockReset().mockResolvedValue(SAVED)
  dbMessagesQuery.where.mockClear()
  dbMessagesQuery.equals.mockClear()
  dbMessagesQuery.sortBy.mockReset().mockResolvedValue([])
})

const session = { id: "s1", title: "Test" } as never
const baseArgs = () => ({ format: "markdown" as const, session })

describe("useSingleExport", () => {
  it("passes the rendered content to saveExport and returns its outcome", async () => {
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.md",
      content: "# hello",
      mimeType: "text/markdown",
    })
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "out.md",
      data: "# hello",
      mimeType: "text/markdown",
    })
    expect(res).toEqual(SAVED)
  })

  it("falls back to Dexie messages when none are provided", async () => {
    dbMessagesQuery.sortBy.mockResolvedValueOnce([{ id: "m1" }])
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.md",
      content: "x",
      mimeType: "text/markdown",
    })
    const { result } = renderHook(() => useSingleExport())
    await act(async () => {
      await result.current.run(baseArgs() as never)
    })
    expect(dbMessagesQuery.where).toHaveBeenCalledWith("sessionId")
    expect(dbMessagesQuery.equals).toHaveBeenCalledWith("s1")
  })

  it("propagates render errors as { kind: 'error' }", async () => {
    renderSingleExportMock.mockImplementationOnce(() => {
      throw new Error("render boom")
    })
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(res).toEqual({ kind: "error", message: "render boom" })
  })

  it("non-Error throws stringified into the result", async () => {
    renderSingleExportMock.mockImplementationOnce(() => {
      throw "string-failure"
    })
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(res).toEqual({ kind: "error", message: "string-failure" })
  })

  it("dispatches start, transform, and complete(true) when the save succeeds", async () => {
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.md",
      content: "# hello",
      mimeType: "text/markdown",
    })
    const hooks = getPluginEventHooks()
    const startSpy = jest.spyOn(hooks, "dispatchExportStart").mockResolvedValue([] as never)
    const transformSpy = jest
      .spyOn(hooks, "dispatchExportTransform")
      .mockImplementation(async (content) => content)
    const completeSpy = jest.spyOn(hooks, "dispatchExportComplete").mockImplementation(() => {})

    const { result } = renderHook(() => useSingleExport())
    await act(async () => {
      await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(startSpy).toHaveBeenCalledWith("s1", "markdown")
    expect(transformSpy).toHaveBeenCalledWith("# hello", "markdown")
    expect(completeSpy).toHaveBeenCalledWith("s1", "markdown", true)
  })

  it("dispatches complete(false) when the user cancels the save dialog", async () => {
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.txt",
      content: "x",
      mimeType: "text/plain",
    })
    saveExportMock.mockResolvedValueOnce({ kind: "cancelled" })
    const hooks = getPluginEventHooks()
    jest.spyOn(hooks, "dispatchExportStart").mockResolvedValue([] as never)
    jest.spyOn(hooks, "dispatchExportTransform").mockImplementation(async (content) => content)
    const completeSpy = jest.spyOn(hooks, "dispatchExportComplete").mockImplementation(() => {})

    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(res).toEqual({ kind: "cancelled" })
    expect(completeSpy).toHaveBeenCalledWith("s1", "markdown", false)
  })

  it("dispatches complete(false) when render throws", async () => {
    renderSingleExportMock.mockImplementationOnce(() => {
      throw new Error("render boom")
    })
    const hooks = getPluginEventHooks()
    jest.spyOn(hooks, "dispatchExportStart").mockResolvedValue([] as never)
    jest.spyOn(hooks, "dispatchExportTransform").mockImplementation(async (content) => content)
    const completeSpy = jest.spyOn(hooks, "dispatchExportComplete").mockImplementation(() => {})

    const { result } = renderHook(() => useSingleExport())
    await act(async () => {
      await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(completeSpy).toHaveBeenCalledWith("s1", "markdown", false)
  })

  it("forwards includeAllBranches to renderSingleExport", async () => {
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.jsonl",
      content: "{}",
      mimeType: "application/x-ndjson",
    })
    const { result } = renderHook(() => useSingleExport())
    await act(async () => {
      await result.current.run({
        format: "jsonl",
        session,
        messages: [],
        includeAllBranches: true,
      } as never)
    })
    expect(renderSingleExportMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: "jsonl", includeAllBranches: true })
    )
  })
})
