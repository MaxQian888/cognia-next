import { transport } from "@/lib/tauri"

type MediaBinaryResponse =
  | ArrayBuffer
  | Uint8Array
  | number[]
  | { transferId: string; byteLength: number; chunkEncoding?: "base64" }

const MAX_MEDIA_BYTES = 128 * 1024 * 1024
const CHUNK_BYTES = 65_536
const DOWNLOAD_WINDOW = 4

/** Desktop IPC carries bytes directly; remote hosts expose bounded, caller-owned chunks. */
export async function callMediaBinary(
  command:
    | "plugin_media_get_video_frame"
    | "plugin_media_export_video"
    | "plugin_media_read_analysis_frame",
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const response = await transport.call<MediaBinaryResponse>(command, args)
  if (response instanceof Uint8Array) return response
  if (response instanceof ArrayBuffer || Array.isArray(response)) return new Uint8Array(response)
  if (!response || typeof response.transferId !== "string" || !response.transferId) {
    throw new Error("Media host returned an invalid binary transfer")
  }
  const { transferId, byteLength } = response
  let failed = false
  try {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_MEDIA_BYTES) {
      throw new Error("Media host returned an invalid transfer size")
    }
    const result = new Uint8Array(byteLength)
    for (let start = 0; start < byteLength; start += CHUNK_BYTES * DOWNLOAD_WINDOW) {
      signal?.throwIfAborted()
      const reads: Promise<void>[] = []
      for (let index = 0; index < DOWNLOAD_WINDOW; index++) {
        const offset = start + index * CHUNK_BYTES
        if (offset >= byteLength) break
        const length = Math.min(CHUNK_BYTES, byteLength - offset)
        reads.push(
          (async () => {
            const chunk = await transport.call<number[] | string>("plugin_media_read_chunk", {
              transferId,
              offset,
              length,
              ...(response.chunkEncoding === "base64" ? { encoding: "base64" } : {}),
            })
            signal?.throwIfAborted()
            let bytes: Uint8Array | number[]
            if (typeof chunk === "string") {
              if (
                chunk.length !== Math.ceil(length / 3) * 4 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)
              ) {
                throw new Error("Media host returned an invalid binary chunk")
              }
              bytes = Uint8Array.from(atob(chunk), (character) => character.charCodeAt(0))
            } else if (
              Array.isArray(chunk) &&
              !chunk.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
            ) {
              bytes = chunk
            } else {
              throw new Error("Media host returned an invalid binary chunk")
            }
            if (bytes.length !== length)
              throw new Error("Media host returned an invalid binary chunk")
            result.set(bytes, offset)
          })()
        )
      }
      // Closing a transfer must not race an outstanding read, including
      // when cancellation or one failed chunk stops the whole window.
      const results = await Promise.allSettled(reads)
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    }
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await transport.call("plugin_media_close_transfer", { transferId })
    } catch (error) {
      // Preserve the operation error when cleanup fails on a disconnected host.
      if (!failed) throw error
    }
  }
}
