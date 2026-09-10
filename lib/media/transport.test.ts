jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import { callMediaBinary } from "./transport"

const call = jest.mocked(transport.call)

beforeEach(() => call.mockReset())

it("requests compact base64 chunks while retaining legacy response compatibility", async () => {
  call
    .mockResolvedValueOnce({ transferId: "t1", byteLength: 3, chunkEncoding: "base64" })
    .mockResolvedValueOnce("AQID")
    .mockResolvedValueOnce(null)
  await expect(callMediaBinary("plugin_media_get_video_frame", {})).resolves.toEqual(
    new Uint8Array([1, 2, 3])
  )
  expect(call).toHaveBeenCalledWith("plugin_media_read_chunk", {
    transferId: "t1",
    offset: 0,
    length: 3,
    encoding: "base64",
  })
})

it("omits encoding for an older host with strict chunk request validation", async () => {
  call.mockImplementation(async (command, args) => {
    if (command === "plugin_media_get_video_frame") return { transferId: "old", byteLength: 2 }
    if (command === "plugin_media_read_chunk") {
      expect(args).toEqual({ transferId: "old", offset: 0, length: 2 })
      return [1, 2]
    }
    return null
  })
  await expect(callMediaBinary("plugin_media_get_video_frame", {})).resolves.toEqual(
    new Uint8Array([1, 2])
  )
})

it("starts a bounded window of reads before awaiting the first response", async () => {
  const pending: Array<() => void> = []
  call.mockImplementation(async (command, args) => {
    if (command === "plugin_media_export_video") return { transferId: "t1", byteLength: 5 * 65_536 }
    if (command === "plugin_media_read_chunk") {
      return new Promise((resolve) =>
        pending.push(() => resolve(Array((args as { length: number }).length).fill(1)))
      )
    }
    return null
  })
  const result = callMediaBinary("plugin_media_export_video", {})
  await Promise.resolve()
  expect(pending).toHaveLength(4)
  pending
    .splice(0)
    .reverse()
    .forEach((resolve) => resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(pending).toHaveLength(1)
  pending.splice(0).forEach((resolve) => resolve())
  expect((await result).byteLength).toBe(5 * 65_536)
})

it.each(["!@#$", "AQ==", "AQI=", "AQIDAAAA"])(
  "rejects malformed or wrong-sized base64 %s",
  async (chunk) => {
    call
      .mockResolvedValueOnce({ transferId: "t1", byteLength: 3 })
      .mockResolvedValueOnce(chunk)
      .mockResolvedValueOnce(null)
    await expect(callMediaBinary("plugin_media_get_video_frame", {})).rejects.toThrow(
      "invalid binary chunk"
    )
    expect(call).toHaveBeenLastCalledWith("plugin_media_close_transfer", { transferId: "t1" })
  }
)

it("drains every outstanding read before closing after a failure", async () => {
  let finishSecond!: (value: number[]) => void
  call
    .mockResolvedValueOnce({ transferId: "t1", byteLength: 65_537 })
    .mockRejectedValueOnce(new Error("read failed"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve
        })
    )
    .mockRejectedValueOnce(new Error("close failed"))
  const result = callMediaBinary("plugin_media_export_video", {})
  const rejected = expect(result).rejects.toThrow("read failed")
  await Promise.resolve()
  await Promise.resolve()
  expect(call).not.toHaveBeenCalledWith("plugin_media_close_transfer", expect.anything())
  finishSecond([1])
  await rejected
  expect(call).toHaveBeenLastCalledWith("plugin_media_close_transfer", { transferId: "t1" })
})

it("does not start a transfer after cancellation", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await expect(callMediaBinary("plugin_media_export_video", {}, controller.signal)).rejects.toThrow(
    "cancelled"
  )
  expect(call).not.toHaveBeenCalled()
})

it("closes a transfer when cancellation arrives during a chunk request", async () => {
  const controller = new AbortController()
  call
    .mockResolvedValueOnce({ transferId: "t1", byteLength: 1 })
    .mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"))
      return [1]
    })
    .mockResolvedValueOnce(null)
  await expect(callMediaBinary("plugin_media_export_video", {}, controller.signal)).rejects.toThrow(
    "cancelled"
  )
  expect(call).toHaveBeenLastCalledWith("plugin_media_close_transfer", { transferId: "t1" })
})

it.each([new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer, [1, 2]])(
  "preserves direct IPC bytes",
  async (response) => {
    call.mockResolvedValue(response)
    expect(await callMediaBinary("plugin_media_get_video_frame", {})).toEqual(
      new Uint8Array([1, 2])
    )
    expect(call).toHaveBeenCalledTimes(1)
  }
)

it("downloads bounded chunks and releases the transfer", async () => {
  call
    .mockResolvedValueOnce({ transferId: "t1", byteLength: 65_538 })
    .mockResolvedValueOnce(Array(65_536).fill(12))
    .mockResolvedValueOnce([13, 14])
    .mockResolvedValueOnce(null)
  const bytes = await callMediaBinary("plugin_media_export_video", { clips: [] })
  expect(bytes.length).toBe(65_538)
  expect(Array.from(bytes.slice(-3))).toEqual([12, 13, 14])
  expect(call).toHaveBeenNthCalledWith(2, "plugin_media_read_chunk", {
    transferId: "t1",
    offset: 0,
    length: 65_536,
  })
  expect(call).toHaveBeenNthCalledWith(3, "plugin_media_read_chunk", {
    transferId: "t1",
    offset: 65_536,
    length: 2,
  })
  expect(call).toHaveBeenLastCalledWith("plugin_media_close_transfer", { transferId: "t1" })
})

it.each([[], [256], [1.5], [-1], null])(
  "rejects malformed chunks and closes the transfer",
  async (chunk) => {
    call
      .mockResolvedValueOnce({ transferId: "t1", byteLength: 1 })
      .mockResolvedValueOnce(chunk)
      .mockResolvedValueOnce(null)
    await expect(callMediaBinary("plugin_media_get_video_frame", {})).rejects.toThrow(
      "invalid binary chunk"
    )
    expect(call).toHaveBeenLastCalledWith("plugin_media_close_transfer", { transferId: "t1" })
  }
)

it.each([-1, 1.5, 128 * 1024 * 1024 + 1, NaN])(
  "rejects invalid transfer size %s and releases it",
  async (byteLength) => {
    call.mockResolvedValueOnce({ transferId: "t1", byteLength }).mockResolvedValueOnce(null)
    await expect(callMediaBinary("plugin_media_export_video", {})).rejects.toThrow(
      "invalid transfer size"
    )
    expect(call).toHaveBeenLastCalledWith("plugin_media_close_transfer", { transferId: "t1" })
  }
)

it("preserves the download failure if disconnected cleanup also fails", async () => {
  call
    .mockResolvedValueOnce({ transferId: "t1", byteLength: 1 })
    .mockRejectedValueOnce(new Error("read failed"))
    .mockRejectedValueOnce(new Error("close failed"))
  await expect(callMediaBinary("plugin_media_export_video", {})).rejects.toThrow("read failed")
})

it("reports failed cleanup after a successful download", async () => {
  call
    .mockResolvedValueOnce({ transferId: "t1", byteLength: 0 })
    .mockRejectedValueOnce(new Error("close failed"))
  await expect(callMediaBinary("plugin_media_export_video", {})).rejects.toThrow("close failed")
})

it.each([null, {}, { transferId: "" }])(
  "rejects invalid transfer descriptors",
  async (response) => {
    call.mockResolvedValueOnce(response)
    await expect(callMediaBinary("plugin_media_export_video", {})).rejects.toThrow(
      "invalid binary transfer"
    )
  }
)
