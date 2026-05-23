/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

// `stores/index.ts` calls `isTauri()` at module top-level inside a Zustand
// `create()` factory; that runs during ES import hoisting, before the test's
// `const mockIsTauri = …` line can initialise. Declaring the jest.fn inside
// the factory dodges the TDZ; tests grab the live ref via `requireMock`.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(false),
}))
const mockIsTauri = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

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
  getDb: () => ({
    messages: dbMessagesQuery,
  }),
}))

const saveDialogMock = jest.fn()
jest.mock(
  "@tauri-apps/plugin-dialog",
  () => ({
    save: (args: unknown) => saveDialogMock(args),
  }),
  { virtual: true }
)

const writeTextFileMock = jest.fn().mockResolvedValue(undefined)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    writeTextFile: (...args: unknown[]) => writeTextFileMock(...args),
  }),
  { virtual: true }
)

import { useSingleExport } from "./use-single-export"
import { getPluginEventHooks } from "@/lib/plugin"

beforeEach(() => {
  mockIsTauri.mockReset().mockReturnValue(false)
  renderSingleExportMock.mockReset()
  saveDialogMock.mockReset()
  writeTextFileMock.mockReset().mockResolvedValue(undefined)
  dbMessagesQuery.where.mockClear()
  dbMessagesQuery.equals.mockClear()
  dbMessagesQuery.sortBy.mockReset().mockResolvedValue([])
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: jest.fn(() => "blob:url"),
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: jest.fn(),
  })
})

const session = { id: "s1", title: "Test" } as never
const baseArgs = () => ({ format: "markdown" as const, session })

describe("useSingleExport", () => {
  it("browser path: triggers a download", async () => {
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.md",
      content: "# hello",
      mimeType: "text/markdown",
    })
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined)
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(res).toMatchObject({ ok: true, canceled: false, filename: "out.md" })
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it("Tauri save success", async () => {
    mockIsTauri.mockReturnValue(true)
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.json",
      content: "{}",
      mimeType: "application/json",
    })
    saveDialogMock.mockResolvedValueOnce("/picked/out.json")
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(writeTextFileMock).toHaveBeenCalledWith("/picked/out.json", "{}")
    expect(res).toMatchObject({ ok: true, canceled: false })
  })

  it("Tauri cancellation returns canceled", async () => {
    mockIsTauri.mockReturnValue(true)
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.txt",
      content: "x",
      mimeType: "text/plain",
    })
    saveDialogMock.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(res).toEqual({ ok: true, canceled: true })
    expect(writeTextFileMock).not.toHaveBeenCalled()
  })

  it("falls back to Dexie messages when none are provided", async () => {
    dbMessagesQuery.sortBy.mockResolvedValueOnce([{ id: "m1" }])
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.md",
      content: "x",
      mimeType: "text/markdown",
    })
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const { result } = renderHook(() => useSingleExport())
    await act(async () => {
      await result.current.run(baseArgs() as never)
    })
    expect(dbMessagesQuery.where).toHaveBeenCalledWith("sessionId")
    expect(dbMessagesQuery.equals).toHaveBeenCalledWith("s1")
  })

  it("propagates render errors as { ok: false }", async () => {
    renderSingleExportMock.mockImplementationOnce(() => {
      throw new Error("render boom")
    })
    const { result } = renderHook(() => useSingleExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    expect(res).toEqual({ ok: false, error: "render boom" })
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
    expect(res).toEqual({ ok: false, error: "string-failure" })
  })

  it("dispatches onExportStart, onExportTransform, and onExportComplete(true) on success", async () => {
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.md",
      content: "# hello",
      mimeType: "text/markdown",
    })
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
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

  it("dispatches onExportComplete(false) when the user cancels the Tauri save dialog", async () => {
    mockIsTauri.mockReturnValue(true)
    renderSingleExportMock.mockReturnValueOnce({
      filename: "out.txt",
      content: "x",
      mimeType: "text/plain",
    })
    saveDialogMock.mockResolvedValueOnce(null)
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

  it("dispatches onExportComplete(false) when render throws", async () => {
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

  it("filename without extension defaults the dialog filter to TXT", async () => {
    mockIsTauri.mockReturnValue(true)
    renderSingleExportMock.mockReturnValueOnce({
      filename: "noext",
      content: "data",
      mimeType: "text/plain",
    })
    saveDialogMock.mockResolvedValueOnce("/x/noext")
    const { result } = renderHook(() => useSingleExport())
    await act(async () => {
      await result.current.run({ ...baseArgs(), messages: [] } as never)
    })
    const args = saveDialogMock.mock.calls[0][0]
    expect(args.filters?.[0].extensions[0]).toBe("txt")
  })
})
