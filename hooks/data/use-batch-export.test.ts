/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(false)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const exportBatchMock = jest.fn()
jest.mock("@/lib/export/batch/batch-export", () => ({
  exportBatch: (args: unknown) => exportBatchMock(args),
}))

const saveDialogMock = jest.fn()
jest.mock(
  "@tauri-apps/plugin-dialog",
  () => ({
    save: (args: unknown) => saveDialogMock(args),
  }),
  { virtual: true }
)

const writeFileMock = jest.fn().mockResolvedValue(undefined)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    writeFile: (path: string, buf: Uint8Array) => writeFileMock(path, buf),
  }),
  { virtual: true }
)

import { useBatchExport } from "./use-batch-export"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(false)
  exportBatchMock.mockReset()
  saveDialogMock.mockReset()
  writeFileMock.mockReset().mockResolvedValue(undefined)
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

const fakeBlob = (): Blob =>
  ({
    arrayBuffer: async () => new ArrayBuffer(8),
  }) as unknown as Blob

const baseArgs = (): {
  sessions: unknown[]
  format: "markdown"
} => ({
  sessions: [{ id: "s1" }, { id: "s2" }],
  format: "markdown",
})

describe("useBatchExport", () => {
  it("browser path: triggers a download via createObjectURL", async () => {
    exportBatchMock.mockResolvedValueOnce({
      filename: "out.zip",
      blob: fakeBlob(),
      exportedCount: 2,
    })
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined)
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({
      ok: true,
      canceled: false,
      filename: "out.zip",
      exportedCount: 2,
    })
    expect(clickSpy).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:url")
    clickSpy.mockRestore()
  })

  it("Tauri path: writes the file and returns ok", async () => {
    isTauriMock.mockReturnValue(true)
    exportBatchMock.mockResolvedValueOnce({
      filename: "out.zip",
      blob: fakeBlob(),
      exportedCount: 1,
    })
    saveDialogMock.mockResolvedValueOnce("/picked/out.zip")
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(writeFileMock).toHaveBeenCalledWith("/picked/out.zip", expect.any(Uint8Array))
    expect(res).toMatchObject({ ok: true, canceled: false })
  })

  it("Tauri path: cancellation returns canceled", async () => {
    isTauriMock.mockReturnValue(true)
    exportBatchMock.mockResolvedValueOnce({
      filename: "out.zip",
      blob: fakeBlob(),
      exportedCount: 1,
    })
    saveDialogMock.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({ ok: true, canceled: true })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it("propagates exportBatch errors as { ok: false }", async () => {
    exportBatchMock.mockRejectedValueOnce(new Error("kaboom"))
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({ ok: false, error: "kaboom" })
  })

  it("non-Error throws are stringified", async () => {
    exportBatchMock.mockRejectedValueOnce("oops")
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({ ok: false, error: "oops" })
  })

  it("busy/progress lifecycle", async () => {
    let resolveExport: (value: unknown) => void = () => undefined
    exportBatchMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveExport = (v) => r(v)
        })
    )
    const { result } = renderHook(() => useBatchExport())
    let promise!: Promise<unknown>
    act(() => {
      promise = result.current.run(baseArgs() as never)
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
      resolveExport({ filename: "f.zip", blob: fakeBlob(), exportedCount: 0 })
      await promise
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.progress).toBeNull()
  })
})
