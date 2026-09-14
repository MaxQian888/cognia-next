jest.mock("@/lib/plugin/api/import-api", () => ({ getCustomImporterOwnersForFile: () => [] }))
jest.mock("@/lib/plugin/api/files-api", () => ({ authorizePluginAttachment: jest.fn() }))

import type { SendContentBlock } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry, VideoPayload } from "../dispatch"
import type { VideoAttachmentInfo } from "./attachment-info"
import type { VideoRouteFacts } from "./delivery-gate"
import { enforceVideoDeliveryForRoute } from "./route-guard"

const gemini: VideoRouteFacts = {
  providerId: "google",
  modelId: "gemini-3.6-flash",
  runtimeAdapter: "ai-sdk",
  protocol: "google",
  supportsVideo: true,
}
const claude: VideoRouteFacts = {
  providerId: "anthropic",
  modelId: "claude-opus-5",
  runtimeAdapter: "claude-agent-sdk",
  protocol: "anthropic",
  supportsVideo: false,
}

const baseInfo: VideoAttachmentInfo = {
  groupId: "g1",
  filename: "demo.mp4",
  sourceMediaType: "video/mp4",
  kind: "video",
  durationSec: 10,
  width: 1280,
  height: 720,
  delivery: "native",
  strategy: "uniform",
  range: null,
  frameTimes: [],
  engine: "browser",
}

const text = (t: string): SendContentBlock => ({ type: "text", text: t })
const image = (data: string): SendContentBlock => ({
  type: "image",
  source: { type: "base64", media_type: "image/jpeg", data },
})
const videoDoc: SendContentBlock = {
  type: "document",
  source: { type: "base64", media_type: "video/mp4", data: "AAAA" },
}

const fallback: VideoPayload = {
  blocks: [text("storyboard of demo.mp4"), image("BOARD")],
  tokens: 5,
  info: {
    ...baseInfo,
    delivery: "storyboard",
    frameTimes: [1, 5, 9],
    grid: { columns: 3, rows: 1 },
  },
}

function nativeTurn() {
  const nativeEntry: AttachmentManifestEntry = {
    filename: "demo.mp4",
    mediaType: "video/mp4",
    kind: "video",
    video: {
      info: baseInfo,
      poster: { mediaType: "image/jpeg", base64: "POSTER", width: 512, height: 288 },
      fallback,
    },
  }
  const imageEntry: AttachmentManifestEntry = {
    filename: "a.png",
    mediaType: "image/png",
    kind: "image",
  }
  return {
    content: [image("PNG"), text("video: demo.mp4"), videoDoc, text("what happens?")],
    manifest: [imageEntry, nativeEntry, nativeEntry],
    imageEntry,
  }
}

describe("enforceVideoDeliveryForRoute", () => {
  it("leaves a native video alone on a route that can take it", () => {
    const turn = nativeTurn()
    const out = enforceVideoDeliveryForRoute(turn.content, turn.manifest, gemini)
    expect(out.content).toBe(turn.content)
    expect(out.manifest).toEqual(turn.manifest)
    expect(out.downgraded).toEqual([])
  })

  it("swaps a native video for its sampled fallback, manifest in lockstep", () => {
    const turn = nativeTurn()
    const out = enforceVideoDeliveryForRoute(turn.content, turn.manifest, claude)
    expect(out.content).toEqual([
      image("PNG"),
      text("storyboard of demo.mp4"),
      image("BOARD"),
      text("what happens?"),
    ])
    expect(out.manifest).toHaveLength(3)
    expect(out.manifest![0]).toBe(turn.imageEntry)
    expect(out.manifest![1]).toBe(out.manifest![2])
    expect(out.manifest![1]).toEqual({
      filename: "demo.mp4",
      mediaType: "video/mp4",
      kind: "video",
      video: { info: fallback.info },
    })
    expect(out.downgraded).toEqual([{ filename: "demo.mp4", reason: "runtime" }])
    expect(out.dropped).toBe(0)
  })

  it("drops a native video that has no fallback instead of sending it", () => {
    const turn = nativeTurn()
    delete turn.manifest[1]!.video!.fallback
    const out = enforceVideoDeliveryForRoute(turn.content, turn.manifest, claude)
    expect(out.content).toEqual([image("PNG"), text("what happens?")])
    expect(out.manifest).toEqual([turn.imageEntry])
    expect(out.dropped).toBe(1)
  })

  it("drops a stray video document with no manifest at all", () => {
    const out = enforceVideoDeliveryForRoute([videoDoc, text("hi")], undefined, claude)
    expect(out.content).toEqual([text("hi")])
    expect(out.manifest).toBeUndefined()
    expect(out.dropped).toBe(1)
  })

  it("does nothing to a turn without native video, or a string turn", () => {
    const sampledOnly = [text("frames"), image("F1")]
    const entry: AttachmentManifestEntry = {
      filename: "demo.mp4",
      mediaType: "video/mp4",
      kind: "video",
      video: { info: fallback.info },
    }
    const out = enforceVideoDeliveryForRoute(sampledOnly, [entry, entry], claude)
    expect(out.content).toBe(sampledOnly)
    expect(enforceVideoDeliveryForRoute("hello", undefined, claude).content).toBe("hello")
  })

  it("reports the gate's reason for the downgrade", () => {
    const turn = nativeTurn()
    const out = enforceVideoDeliveryForRoute(turn.content, turn.manifest, {
      ...gemini,
      teamRoom: true,
    })
    expect(out.downgraded).toEqual([{ filename: "demo.mp4", reason: "team" }])
  })
})
