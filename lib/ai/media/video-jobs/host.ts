/**
 * The process-wide video job engine and the host that configures it.
 *
 * The provider-operations handlers are module constants shared by the app
 * renderer and the CLI, so the engine they use is resolved here. The default
 * host is the CLI's: jobs in memory, the process `fetch`, start frames only as
 * bytes, finished videos kept inline on the row. The renderer's boot
 * initializer installs its own (`renderer-host.ts`): Dexie rows, the platform
 * transport, session-scoped start frames, and results stored as session
 * assets or Files entries.
 */

import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { createVideoJobEngine, type VideoJobEngine, type VideoJobEngineDeps } from "./engine"
import { createInMemoryMediaJobStore } from "./store"
import type { VideoJobContent } from "./types"

/**
 * Largest video the default (CLI) host holds in memory. Matches the app's
 * per-asset ceiling so a job behaves the same wherever it runs; kept local so
 * the CLI build does not pull in the session asset store for a constant.
 */
export const DEFAULT_MAX_VIDEO_BYTES = 500 * 1024 * 1024

export interface VideoJobHost extends Omit<
  VideoJobEngineDeps,
  "startVideo" | "getVideoStatus" | "createModel"
> {
  /** Read a finished video's bytes back from where `materialize` put them. */
  readContent(content: VideoJobContent): Promise<Blob>
}

function defaultHost(): VideoJobHost {
  return {
    store: createInMemoryMediaJobStore(),
    now: () => Date.now(),
    getSnapshot: () => {
      throw new Error("No provider settings are available to this host; pass a snapshot.")
    },
    fetch: (input, init) => {
      if (!init) return fetch(input)
      const { timeout: _timeout, binaryResponse: _binary, ...rest } = init
      return fetch(input, rest)
    },
    reachesNonCorsHosts: () => true,
    async resolveStartFrame(frame) {
      if (frame.kind === "bytes") return { data: frame.data, mediaType: frame.mediaType }
      throw new Error("This host can only take a start frame as image bytes.")
    },
    async materialize(_row, video) {
      const bytes = new Uint8Array(await readBlobAsArrayBuffer(video))
      return {
        content: { kind: "inline", bytes },
        mediaType: video.type || "video/mp4",
        byteSize: bytes.byteLength,
      }
    },
    maxResultBytes: DEFAULT_MAX_VIDEO_BYTES,
    async readContent(content) {
      if (content.kind === "inline") return new Blob([content.bytes as Uint8Array<ArrayBuffer>])
      throw new Error(`This host cannot read a ${content.kind} video.`)
    },
  }
}

let host: VideoJobHost = defaultHost()
let engine: VideoJobEngine = createVideoJobEngine(host)

export function getVideoJobEngine(): VideoJobEngine {
  return engine
}

export function getVideoJobHost(): VideoJobHost {
  return host
}

/** Install a host. Returns a function restoring the previous one. */
export function installVideoJobHost(next: VideoJobHost): () => void {
  const previous = { host, engine }
  host = next
  engine = createVideoJobEngine(next)
  return () => {
    if (host !== next) return
    host = previous.host
    engine = previous.engine
  }
}
