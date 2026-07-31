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

// The platform write is delegated to the unified saver; mock it so these tests
// focus on the hook's orchestration + result shaping.
const saveExportMock = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (args: unknown) => saveExportMock(args),
}))

import { useBatchExport } from "./use-batch-export"

const SAVED = {
  kind: "saved" as const,
  platform: "web" as const,
  location: "downloads",
  filename: "out.zip",
}

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(false)
  exportBatchMock.mockReset()
  saveExportMock.mockReset().mockResolvedValue(SAVED)
})

const fakeBlob = (): Blob =>
  ({
    arrayBuffer: async () => new ArrayBuffer(8),
  }) as unknown as Blob

const baseArgs = (): { sessions: unknown[]; format: "markdown" } => ({
  sessions: [{ id: "s1" }, { id: "s2" }],
  format: "markdown",
})

describe("useBatchExport", () => {
  it("saves the ZIP and returns outcome + count on success", async () => {
    const blob = fakeBlob()
    exportBatchMock.mockResolvedValueOnce({ filename: "out.zip", blob, exportedCount: 2 })
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "out.zip",
      data: blob,
      mimeType: "application/zip",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    })
    expect(res).toEqual({ outcome: SAVED, exportedCount: 2 })
  })

  it("reports exportedCount 0 when the save was cancelled", async () => {
    exportBatchMock.mockResolvedValueOnce({
      filename: "out.zip",
      blob: fakeBlob(),
      exportedCount: 3,
    })
    saveExportMock.mockResolvedValueOnce({ kind: "cancelled" })
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({ outcome: { kind: "cancelled" }, exportedCount: 0 })
  })

  it("propagates exportBatch errors as an error outcome", async () => {
    exportBatchMock.mockRejectedValueOnce(new Error("kaboom"))
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({ outcome: { kind: "error", message: "kaboom" }, exportedCount: 0 })
  })

  it("non-Error throws are stringified", async () => {
    exportBatchMock.mockRejectedValueOnce("oops")
    const { result } = renderHook(() => useBatchExport())
    let res: unknown
    await act(async () => {
      res = await result.current.run(baseArgs() as never)
    })
    expect(res).toEqual({ outcome: { kind: "error", message: "oops" }, exportedCount: 0 })
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
