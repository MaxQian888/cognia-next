/** @jest-environment jsdom */
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  clearTemporarySessionAssets,
  getSessionAssetMetadata,
  listLibraryAssets,
} from "@/lib/db/session-assets"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import {
  GENERATED_VIDEO_APP_DATA_DIR,
  activeDatabaseAppDataDir,
} from "@/lib/tauri/account-app-data"
import type { MediaGenerationJobRow } from "./types"

const platformKind = jest.fn(() => "tauri")
jest.mock("@/lib/network/platform-fetch", () => ({
  createPlatformFetch: () => jest.fn(),
  platformFetchKind: () => platformKind(),
  reachesNonCorsHosts: () => true,
}))
const referenced = jest.fn()
const getMessageMedia = jest.fn()
jest.mock("@/lib/db/message-media-refs", () => ({
  ...jest.requireActual("@/lib/db/message-media-refs"),
  isMessageMediaReferencedBySession: (...args: unknown[]) => referenced(...args),
}))
jest.mock("@/lib/db/message-media", () => ({
  ...jest.requireActual("@/lib/db/message-media"),
  getMessageMedia: (...args: unknown[]) => getMessageMedia(...args),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {
        defaultProvider: "google",
        providerSettings: { google: { enabled: true, apiKey: "g" } },
        customProviders: [],
        videoGeneration: { agentTool: true, providerId: "google" },
      },
    }),
  },
}))
const appData = new Map<string, Uint8Array>()
const writeBlobToAppData = jest.fn(async (relativePath: string, blob: Blob) => {
  appData.set(relativePath, new Uint8Array(await readBlobAsArrayBuffer(blob)))
  return `/data/${relativePath}`
})
jest.mock("@/lib/tauri/app-data-files", () => ({
  writeBlobToAppData: (relativePath: string, blob: Blob) => writeBlobToAppData(relativePath, blob),
  appDataFileExists: async (relativePath: string) => appData.has(relativePath),
  appDataPath: async (relativePath: string) => `/data/${relativePath}`,
  readAppDataFile: async (relativePath: string) => appData.get(relativePath)!,
}))

import {
  DESKTOP_BRIDGE_MAX_BYTES,
  createRendererVideoJobHost,
  currentVideoGenerationSettings,
  generatedVideoFilename,
  readRendererVideo,
  reachableVideoProviderIds,
  resolveRendererStartFrame,
  videoAssetId,
} from "./renderer-host"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  clearTemporarySessionAssets()
  appData.clear()
  jest.clearAllMocks()
  await getDb().sessions.bulkPut([
    { id: "s1", title: "s1", createdAt: 1, updatedAt: 1 } as ChatSession,
  ])
})
afterAll(fixture.dispose)

function job(id: string, origin: MediaGenerationJobRow["origin"]): MediaGenerationJobRow {
  return {
    id,
    kind: "video",
    ...(origin.surface === "chat-tool" ? { sessionId: origin.sessionId } : {}),
    origin,
    request: { prompt: "a boat" },
    provider: { providerId: "google", modelId: "veo", credentialAffinity: "a" },
    operation: {},
    status: "downloading",
    pollCount: 1,
    nextPollAt: 0,
    deadlineAt: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

const video = () => new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" })

describe("renderer video job host", () => {
  it("stores a chat job's video as a session asset, once", async () => {
    const host = createRendererVideoJobHost({ describe: async () => ({ durationSec: 5 }) })
    const row = job("vjob_chat", { surface: "chat-tool", sessionId: "s1" })
    const first = await host.materialize(row, video())
    const again = await host.materialize(row, video())
    expect(first).toEqual({
      content: { kind: "session-asset", sessionId: "s1", assetId: videoAssetId("vjob_chat") },
      mediaType: "video/mp4",
      byteSize: 3,
      durationSec: 5,
    })
    expect(again.content).toEqual(first.content)
    const stored = await getSessionAssetMetadata("s1", "video-vjob_chat")
    // Named after the prompt, so Files and downloads read as what was asked for.
    expect(stored).toMatchObject({ mediaType: "video/mp4", byteSize: 3, filename: "a boat.mp4" })
  })

  it("writes a workflow job's video to AppData, once, and reads it back", async () => {
    const host = createRendererVideoJobHost({ describe: async () => ({}) })
    const row = job("vjob_flow", { surface: "workflow", runId: "r1", stepId: "s1" })
    const first = await host.materialize(row, video())
    const again = await host.materialize(row, video())
    // In the directory of the database holding the row, which clearing it removes.
    const dir = activeDatabaseAppDataDir(GENERATED_VIDEO_APP_DATA_DIR)
    expect(dir).toBe(`generated-videos/${dir.split("/")[1]}/${getDb().name}`)
    const relativePath = `${dir}/vjob_flow.mp4`
    expect(first.content).toEqual({ kind: "file", relativePath, path: `/data/${relativePath}` })
    expect(again.content).toEqual(first.content)
    expect(writeBlobToAppData).toHaveBeenCalledTimes(1)
    const read = await readRendererVideo(first.content)
    expect(Array.from(new Uint8Array(await readBlobAsArrayBuffer(read)))).toEqual([1, 2, 3])
    expect(read.type).toBe("video/mp4")
    await expect(
      readRendererVideo({ kind: "file", relativePath: "gone.mp4", path: "/data/gone.mp4" })
    ).rejects.toThrow("no longer stored")
  })

  it("keeps a plugin job's video in Files", async () => {
    const host = createRendererVideoJobHost({ describe: async () => ({}) })
    const result = await host.materialize(
      job("vjob_plugin", { surface: "plugin", pluginId: "p" }),
      video()
    )
    expect(result.content).toEqual({ kind: "library", assetId: "video-vjob_plugin" })
    expect((await listLibraryAssets()).map((asset) => asset.assetId)).toContain("video-vjob_plugin")
    await expect(readRendererVideo({ kind: "library", assetId: "gone" })).rejects.toThrow(
      "no longer stored"
    )
    await expect(
      readRendererVideo({ kind: "session-asset", sessionId: "s1", assetId: "gone" })
    ).rejects.toThrow("no longer stored")
  })

  it("caps downloads at the desktop bridge limit, and at the asset limit elsewhere", () => {
    expect(createRendererVideoJobHost().maxResultBytes).toBe(DESKTOP_BRIDGE_MAX_BYTES)
    platformKind.mockReturnValue("capacitor")
    expect(createRendererVideoJobHost().maxResultBytes).toBeGreaterThan(DESKTOP_BRIDGE_MAX_BYTES)
  })

  it("reads provider settings from the settings store", () => {
    expect(createRendererVideoJobHost().getSnapshot()).toMatchObject({ defaultProvider: "google" })
    expect(currentVideoGenerationSettings()).toEqual({ agentTool: true, providerId: "google" })
    expect(reachableVideoProviderIds()).toEqual(["google"])
  })
})

describe("generatedVideoFilename", () => {
  it("names the file after the prompt's first line", () => {
    expect(
      generatedVideoFilename("\n A paper boat:\non a rainy street", "vjob_1", "video/mp4")
    ).toBe("A paper boat_.mp4")
    expect(generatedVideoFilename("纸船 在雨中", "vjob_1", "video/webm")).toBe("纸船 在雨中.webm")
  })

  it("cuts a long prompt at a word and falls back to the job id", () => {
    const long = `${"word ".repeat(30)}end`
    const name = generatedVideoFilename(long, "vjob_1", "video/quicktime")
    expect(name.endsWith("word.mov")).toBe(true)
    expect(name.length).toBeLessThanOrEqual(84)
    expect(generatedVideoFilename("  ...  ", "vjob_1", "video/mp4")).toBe("video-vjob_1.mp4")
    expect(generatedVideoFilename("?!*", "vjob_1", "video/mp4")).toBe("video-vjob_1.mp4")
  })

  it("never splits an emoji sequence at the cut", () => {
    const family = "👨‍👩‍👧"
    const name = generatedVideoFilename(`${"a".repeat(79)}${family}${family}`, "j", "video/mp4")
    expect(name).toBe(`${"a".repeat(79)}${family}.mp4`)
  })
})

describe("resolveRendererStartFrame", () => {
  const chat = { surface: "chat-tool", sessionId: "s1" } as const

  it("resolves an image the conversation references, preferring its original", async () => {
    referenced.mockResolvedValue(true)
    getMessageMedia.mockResolvedValue({
      blob: new Blob([new Uint8Array([1])], { type: "image/webp" }),
      mediaType: "image/webp",
      originalBlob: new Blob([new Uint8Array([7, 7])], { type: "image/png" }),
      originalMediaType: "image/png",
    })
    const frame = await resolveRendererStartFrame({ kind: "media", ref: "cognia-media:abc" }, chat)
    expect(frame.mediaType).toBe("image/png")
    expect(Array.from(frame.data)).toEqual([7, 7])
    expect(referenced).toHaveBeenCalledWith("s1", "cognia-media:abc")
  })

  it("refuses an image from another conversation or outside one", async () => {
    referenced.mockResolvedValue(false)
    await expect(
      resolveRendererStartFrame({ kind: "media", ref: "cognia-media:abc" }, chat)
    ).rejects.toThrow("not part of this conversation")
    await expect(
      resolveRendererStartFrame({ kind: "media", ref: "cognia-media:abc" }, { surface: "executor" })
    ).rejects.toThrow("outside a conversation")
    await expect(
      resolveRendererStartFrame({ kind: "session-asset", assetId: "missing" }, chat)
    ).rejects.toThrow("not part of this conversation")
  })

  it("passes image bytes straight through", async () => {
    await expect(
      resolveRendererStartFrame(
        { kind: "bytes", data: new Uint8Array([3]), mediaType: "image/png" },
        { surface: "executor" }
      )
    ).resolves.toEqual({ data: new Uint8Array([3]), mediaType: "image/png" })
  })
})

describe("ensureRendererVideoJobHost", () => {
  it("installs the Dexie-backed host once", async () => {
    const { getVideoJobHost } = await import("./host")
    const { ensureRendererVideoJobHost, __resetRendererVideoJobHostForTests } =
      await import("./renderer-host")
    __resetRendererVideoJobHostForTests()
    const before = getVideoJobHost()
    ensureRendererVideoJobHost()
    const installed = getVideoJobHost()
    expect(installed).not.toBe(before)
    expect(installed.maxResultBytes).toBeGreaterThan(0)
    ensureRendererVideoJobHost()
    expect(getVideoJobHost()).toBe(installed)
  })
})
