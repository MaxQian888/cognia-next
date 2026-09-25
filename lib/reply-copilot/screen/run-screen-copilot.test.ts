jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: jest.fn() }))
jest.mock("@/lib/db/platform-identities", () => ({
  ...jest.requireActual("@/lib/db/platform-identities"),
  findByDisplayName: jest.fn(),
}))
jest.mock("../load-context", () => ({
  copilotMemoryAllowed: jest.fn(() => false),
  recallCopilotMemory: jest.fn(async () => []),
}))
jest.mock("../run-copilot", () => ({ runCopilot: jest.fn() }))
jest.mock("./local-ocr", () => {
  class LocalOcrUnavailableError extends Error {}
  return { LocalOcrUnavailableError, readWindowText: jest.fn() }
})

import type { FrontmostWindowCapture } from "@/lib/automation/client"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { CopilotResult } from "../run-copilot"
import type { ScreenLine } from "./bubble-grouper"
import { LocalOcrUnavailableError } from "./local-ocr"
import {
  ScreenCopilotError,
  classifyCaptureError,
  composerInFrame,
  draftForScreen,
  readChatScreen,
  type ScreenCopilotDeps,
} from "./run-screen-copilot"

/** A 500x400-point WeChat window captured at 2x; the composer is focused. */
const capture: FrontmostWindowCapture = {
  screenshot: { bytes: "", width: 1000, height: 800, capturedAt: 0, format: "png" },
  appName: "WeChat",
  bundleId: "com.tencent.xinWeChat",
  windowTitle: "WeChat",
  processId: 42,
  logicalBounds: { x: 100, y: 50, width: 500, height: 400 },
  scaleFactor: 2,
  redacted: false,
  focusBounds: { x: 250, y: 350, width: 340, height: 75 },
  focusRole: "AXTextArea",
}

function line(text: string, x: number, y: number, width: number, height = 24): ScreenLine {
  return { text, bbox: { x, y, width, height } }
}

const lines = [
  line("Ann", 320, 20, 60, 28),
  line("明天的会你来吗", 370, 100, 200),
  line("来", 780, 200, 160),
  line("几点？", 370, 260, 120),
]

const contact = {
  id: "pid_ann",
  displayName: "Ann",
  relationship: "manager",
} as PlatformIdentityRow

function deps(overrides: Partial<ScreenCopilotDeps> = {}) {
  const d: ScreenCopilotDeps = {
    capture: jest.fn(async () => capture),
    readText: jest.fn(async () => ({ providerId: "apple-vision", lines })),
    findContact: jest.fn(async (name: string) =>
      name === "Ann" ? { kind: "match" as const, primary: contact } : { kind: "none" as const }
    ),
    recall: jest.fn(async () => []),
    runCopilot: jest.fn(),
    buildClient: jest.fn(() => ({}) as LlmClient),
    ...overrides,
  }
  return d
}

describe("classifyCaptureError", () => {
  it.each([
    [{ code: "PERMISSION_DENIED", reason: "chat_copilot_self_window" }, "self_window"],
    [
      { code: "PERMISSION_DENIED", reason: "chat_copilot_screen_recording_required" },
      "screen_recording_required",
    ],
    [{ code: "PERMISSION_DENIED", reason: "chat_copilot_no_frontmost_app" }, "no_frontmost_app"],
    [{ code: "PERMISSION_DENIED", reason: "hard target: 1Password" }, "blocked_target"],
    [{ code: "USER_DECLINED" }, "declined"],
    [{ code: "KILL_SWITCH_ACTIVE" }, "kill_switch"],
    [{ code: "UNSUPPORTED_PLATFORM" }, "unsupported_platform"],
    [{ code: "BACKEND_ERROR", message: "x" }, "capture_failed"],
  ])("maps %j to %s", (error, kind) => {
    expect(classifyCaptureError(JSON.stringify(error))).toBe(kind)
    expect(classifyCaptureError(new Error(JSON.stringify(error)))).toBe(kind)
  })

  it("treats an unparseable rejection as a failed capture", () => {
    expect(classifyCaptureError("boom")).toBe("capture_failed")
  })
})

describe("composerInFrame", () => {
  it("maps the focused composer from points into frame pixels", () => {
    expect(composerInFrame(capture)).toEqual({ x: 300, y: 600, width: 680, height: 150 })
  })

  it("ignores a focus that is not a text input", () => {
    expect(composerInFrame({ ...capture, focusRole: "AXButton" })).toBeNull()
    expect(composerInFrame({ ...capture, focusBounds: null })).toBeNull()
  })
})

describe("readChatScreen", () => {
  it("reads the conversation, sides and the contact named in the chat header", async () => {
    const d = deps()
    const phases: unknown[] = []
    const read = await readChatScreen(
      {} as never,
      { onPhase: (phase, anchor) => phases.push(anchor ? [phase, anchor.width] : phase) },
      d
    )
    expect(phases).toEqual(["capturing", ["reading", 500]])
    expect(read.transcript.turns).toEqual([
      { from: "other", text: "明天的会你来吗" },
      { from: "me", text: "来" },
      { from: "other", text: "几点？" },
    ])
    expect(read.unsidedReason).toBeNull()
    expect(read.app).toEqual({
      name: "WeChat",
      windowTitle: "WeChat",
      id: "wechat",
      layout: "two_sided",
    })
    expect(read.anchor).toEqual({ x: 100, y: 50, width: 500, height: 400, scale: 2 })
    expect(read.contact).toEqual({ kind: "match", name: "Ann" })
    expect(read.knowledge).toMatchObject({ relationship: "manager", contactId: "pid_ann" })
    // The window title is only the app's name, so it is never looked up.
    expect(d.findContact).toHaveBeenCalledTimes(1)
  })

  it("never guesses between two contacts with the header's name", async () => {
    const d = deps({ findContact: jest.fn(async () => ({ kind: "ambiguous" as const, count: 2 })) })
    const read = await readChatScreen(null, {}, d)
    expect(read.contact).toEqual({ kind: "ambiguous", name: "Ann" })
    expect(read.knowledge.contactId).toBeNull()
  })

  it("explains each way the read can stop", async () => {
    await expect(
      readChatScreen(
        null,
        {},
        deps({
          capture: jest.fn(async () => Promise.reject(JSON.stringify({ code: "USER_DECLINED" }))),
        })
      )
    ).rejects.toMatchObject({ kind: "declined" })
    await expect(
      readChatScreen(
        null,
        {},
        deps({ capture: jest.fn(async () => ({ ...capture, redacted: true })) })
      )
    ).rejects.toMatchObject({ kind: "credential_window" })
    await expect(
      readChatScreen(
        null,
        {},
        deps({ readText: jest.fn(async () => Promise.reject(new LocalOcrUnavailableError())) })
      )
    ).rejects.toMatchObject({ kind: "no_local_ocr" })
    await expect(
      readChatScreen(
        null,
        {},
        deps({ readText: jest.fn(async () => Promise.reject(new Error("x"))) })
      )
    ).rejects.toMatchObject({ kind: "ocr_failed" })
    await expect(
      readChatScreen(
        null,
        {},
        deps({ readText: jest.fn(async () => ({ providerId: "apple-vision", lines: [] })) })
      )
    ).rejects.toBeInstanceOf(ScreenCopilotError)
  })
})

describe("draftForScreen", () => {
  it("runs the shared copilot over the read, with the user's steering", async () => {
    const result = { variant: "full" } as CopilotResult
    const d = deps({ runCopilot: jest.fn(async () => result) })
    const read = await readChatScreen(null, {}, d)
    await expect(draftForScreen(read, null, { instructions: "say 3pm" }, d)).resolves.toBe(result)
    expect(d.runCopilot).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: read.transcript,
        knowledge: read.knowledge,
        instructions: "say 3pm",
      })
    )
  })
})
