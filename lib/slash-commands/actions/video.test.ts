import type { SlashContext } from "../builtin"
import { buildArgs } from "../build-args"
import {
  VIDEO_COMMAND_PARAMS,
  handleVideoCommand,
  parseVideoArgs,
  type VideoCommandDeps,
} from "./video"

function ctx(overrides: Partial<SlashContext> = {}) {
  const pushSystemMessage = jest.fn()
  const consumeStagedFiles = jest.fn()
  const value = {
    args: "a paper boat",
    activeSessionId: "s1",
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings: jest.fn(),
    setPermissionMode: jest.fn(),
    pushSystemMessage,
    consumeStagedFiles,
    ...overrides,
  } as SlashContext
  return { ctx: value, pushSystemMessage, consumeStagedFiles }
}

function deps(overrides: Partial<VideoCommandDeps> = {}) {
  const start = jest.fn<
    ReturnType<VideoCommandDeps["start"]>,
    Parameters<VideoCommandDeps["start"]>
  >(async () => ({ ok: true, job: { id: "vjob_1" } as never }))
  const saveFrame = jest.fn(async () => undefined)
  const releaseFrame = jest.fn(async () => undefined)
  const postCard = jest.fn(async () => undefined)
  const value: VideoCommandDeps = {
    start,
    settings: () => ({ agentTool: true, providerId: "google", durationSec: 8 }),
    configuredProviders: () => ["google"],
    projectIdOf: async () => undefined,
    readStaged: jest.fn(async () => new Blob(["png"], { type: "image/png" })),
    saveFrame,
    releaseFrame,
    newFrameId: () => "video-frame-1",
    postCard,
    ...overrides,
  }
  return { deps: value, start, saveFrame, releaseFrame, postCard }
}

describe("parseVideoArgs", () => {
  it("reads the flags anywhere and keeps the rest as the prompt", () => {
    expect(
      parseVideoArgs("a paper boat --duration 5 on a rainy street --aspect 9:16 --provider doubao")
    ).toEqual({
      prompt: "a paper boat on a rainy street",
      durationSec: 5,
      aspectRatio: "9:16",
      providerId: "doubao",
    })
    expect(parseVideoArgs("boat --Duration 4")).toEqual({ prompt: "boat", durationSec: 4 })
    expect(parseVideoArgs("boat --resolution 1280x720 --model m1")).toEqual({
      prompt: "boat",
      resolution: "1280x720",
      model: "m1",
    })
  })

  it("leaves dashes inside the prompt alone", () => {
    expect(parseVideoArgs("a sci-fi city -- at dusk").prompt).toBe("a sci-fi city -- at dusk")
  })

  it("refuses unknown flags, missing values and malformed options", () => {
    expect(() => parseVideoArgs("boat --fps 24")).toThrow("Unknown flag: --fps")
    expect(() => parseVideoArgs("boat --duration")).toThrow("--duration requires a value")
    expect(() => parseVideoArgs("boat --duration -2")).toThrow("positive")
    expect(() => parseVideoArgs("boat --aspect wide")).toThrow("16:9")
    expect(() => parseVideoArgs("boat --resolution hd")).toThrow("1280x720")
  })

  it("parses what the guided form emits", () => {
    const args = buildArgs(VIDEO_COMMAND_PARAMS, {
      prompt: "a paper boat",
      duration: "6",
      aspect: "16:9",
      provider: "google",
    })
    expect(parseVideoArgs(args)).toEqual({
      prompt: "a paper boat",
      durationSec: 6,
      aspectRatio: "16:9",
      providerId: "google",
    })
  })
})

describe("handleVideoCommand", () => {
  it("starts a slash job with the saved defaults and pushes its card", async () => {
    const c = ctx()
    const t = deps()
    await handleVideoCommand(c.ctx, t.deps)
    expect(t.start).toHaveBeenCalledWith({
      prompt: "a paper boat",
      providerId: "google",
      params: { durationSec: 8 },
      origin: { surface: "slash", sessionId: "s1" },
    })
    // The card is written to the transcript, not only pushed in memory.
    expect(t.postCard).toHaveBeenCalledWith("s1", "vjob_1")
    expect(c.pushSystemMessage).not.toHaveBeenCalled()
  })

  it("stores the first staged image as the start frame and takes it out of the turn", async () => {
    const c = ctx({
      stagedFiles: [
        { id: "f1", url: "blob:doc", mediaType: "application/pdf", filename: "a.pdf" },
        { id: "f2", url: "blob:img", mediaType: "image/png", filename: "cat.png" },
        { id: "f3", url: "blob:img2", mediaType: "image/jpeg" },
      ],
    })
    const t = deps()
    await handleVideoCommand(c.ctx, t.deps)
    expect(c.consumeStagedFiles).toHaveBeenCalledWith(["f2"])
    expect(t.saveFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        assetId: "video-frame-1",
        filename: "cat.png",
        mediaType: "image/png",
      })
    )
    expect(t.start.mock.calls[0]![0].startFrame).toEqual({
      kind: "session-asset",
      assetId: "video-frame-1",
    })
  })

  it("releases the stored frame and reports the reason when the job does not start", async () => {
    const c = ctx({
      stagedFiles: [{ id: "f2", url: "blob:img", mediaType: "image/png" }],
    })
    const t = deps({
      start: jest.fn(async () => ({
        ok: false as const,
        error: { code: "unsupported_input" as const, message: "text only", recheckable: false },
      })),
    })
    await handleVideoCommand(c.ctx, t.deps)
    expect(t.releaseFrame).toHaveBeenCalledWith("s1", "video-frame-1")
    expect(c.pushSystemMessage).toHaveBeenCalledWith("Could not start the video: text only")
  })

  it("needs a conversation and a prompt, and explains bad flags", async () => {
    const t = deps()
    const noSession = ctx({ activeSessionId: null })
    await handleVideoCommand(noSession.ctx, t.deps)
    expect(noSession.pushSystemMessage.mock.calls[0]![0]).toMatch(/Start a chat session first/)

    const empty = ctx({ args: "--duration 5" })
    await handleVideoCommand(empty.ctx, t.deps)
    expect(empty.pushSystemMessage.mock.calls[0]![0]).toMatch(/^Usage:/)

    const bad = ctx({ args: "boat --fps 24" })
    await handleVideoCommand(bad.ctx, t.deps)
    expect(bad.pushSystemMessage.mock.calls[0]![0]).toMatch(/Unknown flag: --fps\. Usage:/)
    expect(t.start).not.toHaveBeenCalled()
  })

  it("takes the staged image even when the command refuses, so it is not sent as a turn", async () => {
    const t = deps()
    for (const overrides of [{ activeSessionId: null }, { args: "" }, { args: "x --fps 1" }]) {
      const c = ctx({
        ...overrides,
        stagedFiles: [{ id: "f2", url: "blob:img", mediaType: "image/png" }],
      })
      await handleVideoCommand(c.ctx, t.deps)
      expect(c.consumeStagedFiles).toHaveBeenCalledWith(["f2"])
    }
    expect(t.start).not.toHaveBeenCalled()
  })

  it("releases the stored frame when starting throws", async () => {
    const c = ctx({ stagedFiles: [{ id: "f2", url: "blob:img", mediaType: "image/png" }] })
    const t = deps({ start: jest.fn(async () => Promise.reject(new Error("db closed"))) })
    await expect(handleVideoCommand(c.ctx, t.deps)).rejects.toThrow("db closed")
    expect(t.releaseFrame).toHaveBeenCalledWith("s1", "video-frame-1")
    expect(t.postCard).not.toHaveBeenCalled()
  })

  it("reports an unreadable staged image without starting", async () => {
    const c = ctx({ stagedFiles: [{ id: "f2", url: "blob:gone", mediaType: "image/png" }] })
    const t = deps({ readStaged: jest.fn(async () => Promise.reject(new Error("revoked"))) })
    await handleVideoCommand(c.ctx, t.deps)
    expect(c.pushSystemMessage).toHaveBeenCalledWith("Could not use the staged image: revoked")
    expect(t.start).not.toHaveBeenCalled()
  })
})
