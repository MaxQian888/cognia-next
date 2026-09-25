/**
 * The desktop chat copilot's pipeline (ADR-0194 §8): capture the frontmost
 * chat window once, read it with local OCR, rebuild the conversation from
 * bubble geometry, and hand it to the same `runCopilot` the in-app copilot
 * uses. Nothing is typed into the other app; the output is candidates to copy.
 *
 * Split in two so "try again with instructions" re-drafts from the SAME read:
 * by then the chat window may no longer be frontmost, and re-capturing would
 * ask for consent again to read something the user already approved.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  CHAT_COPILOT_CAPTURE_REASONS,
  desktop,
  type FrontmostWindowCapture,
} from "@/lib/automation/client"
import { parseAutomationError, type Rect, type Screenshot } from "@/lib/automation/types"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { findByDisplayName, type DisplayNameMatch } from "@/lib/db/platform-identities"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { CopilotTranscript } from "../build-state"
import { gatherKnowledge, type CopilotKnowledge } from "../knowledge"
import { copilotMemoryAllowed, recallCopilotMemory } from "../load-context"
import { runCopilot, type CopilotResult } from "../run-copilot"
import { groupBubbles, type ScreenLine, type ScreenRect } from "./bubble-grouper"
import { resolveChatApp, type ChatLayout } from "./chat-apps"
import { LocalOcrUnavailableError, readWindowText } from "./local-ocr"
import { buildScreenTranscript, type UnsidedReason } from "./screen-transcript"

export const SCREEN_COPILOT_FEATURE_ID = "desktop-chat-copilot"

export type ScreenCopilotErrorKind =
  | "unsupported_platform"
  | "screen_recording_required"
  | "self_window"
  | "no_frontmost_app"
  | "blocked_target"
  | "declined"
  | "kill_switch"
  | "credential_window"
  | "capture_failed"
  | "no_local_ocr"
  | "ocr_failed"
  | "no_messages"

export class ScreenCopilotError extends Error {
  constructor(
    readonly kind: ScreenCopilotErrorKind,
    message?: string
  ) {
    super(message ?? kind)
    this.name = "ScreenCopilotError"
  }
}

/** Map a rejected capture to the reason the overlay explains. */
export function classifyCaptureError(raw: unknown): ScreenCopilotErrorKind {
  const error = parseAutomationError(raw instanceof Error ? raw.message : raw)
  switch (error?.code) {
    case "PERMISSION_DENIED":
      if (error.reason === CHAT_COPILOT_CAPTURE_REASONS.selfWindow) return "self_window"
      if (error.reason === CHAT_COPILOT_CAPTURE_REASONS.screenRecordingRequired) {
        return "screen_recording_required"
      }
      if (error.reason === CHAT_COPILOT_CAPTURE_REASONS.noFrontmostApp) return "no_frontmost_app"
      return "blocked_target"
    case "USER_DECLINED":
      return "declined"
    case "KILL_SWITCH_ACTIVE":
      return "kill_switch"
    case "UNSUPPORTED_PLATFORM":
      return "unsupported_platform"
    default:
      return "capture_failed"
  }
}

const COMPOSER_ROLE = /(textarea|textfield|^edit$|^document$)/i

/** The focused element, in frame pixels, when it can be the message composer. */
export function composerInFrame(capture: FrontmostWindowCapture): ScreenRect | null {
  const focus = capture.focusBounds
  if (!focus || !capture.focusRole || !COMPOSER_ROLE.test(capture.focusRole)) return null
  const bounds = capture.logicalBounds
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const shot = capture.screenshot
  const sx = (shot.sourceWidth ?? shot.width) / bounds.width
  const sy = (shot.sourceHeight ?? shot.height) / bounds.height
  return {
    x: (focus.x - bounds.x) * sx,
    y: (focus.y - bounds.y) * sy,
    width: focus.width * sx,
    height: focus.height * sy,
  }
}

export type ScreenContactStatus =
  { kind: "match"; name: string } | { kind: "ambiguous"; name: string } | { kind: "none" }

/** The captured window in global logical points, for placing the overlay. */
export type ScreenAnchor = Rect & { scale: number }

export interface ScreenRead {
  app: { name: string; windowTitle: string | null; id: string | null; layout: ChatLayout }
  anchor: ScreenAnchor
  transcript: CopilotTranscript
  unsidedReason: UnsidedReason | null
  bubbleCount: number
  contact: ScreenContactStatus
  knowledge: CopilotKnowledge
  ocrProviderId: string
}

export type ScreenPhase = "capturing" | "reading" | "thinking"

export interface ScreenCopilotDeps {
  capture: () => Promise<FrontmostWindowCapture>
  readText: (
    shot: Screenshot,
    signal?: AbortSignal
  ) => Promise<{ providerId: string; lines: ScreenLine[] }>
  findContact: (name: string) => Promise<DisplayNameMatch>
  recall: (settings: AppSettings | null | undefined, query: string) => Promise<string[]>
  runCopilot: typeof runCopilot
  buildClient: (settings: AppSettings | null | undefined) => LlmClient | null
}

export const defaultScreenCopilotDeps: ScreenCopilotDeps = {
  capture: () => desktop.captureFrontmostWindow(),
  readText: (shot, signal) => readWindowText(shot, signal),
  findContact: findByDisplayName,
  recall: recallCopilotMemory,
  runCopilot: (input) => runCopilot(input),
  buildClient: (settings) =>
    buildUtilityLlmClient({
      session: null,
      appSettings: settings,
      override: settings?.composerAssistance?.model,
      featureId: SCREEN_COPILOT_FEATURE_ID,
    }),
}

/**
 * Contact knowledge only for an exact, unique name: the chat header first
 * (it names the conversation), then a window title that is not just the
 * app's own name.
 */
async function matchContact(
  candidates: Array<string | null>,
  deps: ScreenCopilotDeps
): Promise<{ status: ScreenContactStatus; match: DisplayNameMatch | null }> {
  let ambiguous: string | null = null
  for (const name of candidates) {
    if (!name?.trim()) continue
    const match = await deps.findContact(name)
    if (match.kind === "match") return { status: { kind: "match", name }, match }
    if (match.kind === "ambiguous") ambiguous ??= name
  }
  return {
    status: ambiguous ? { kind: "ambiguous", name: ambiguous } : { kind: "none" },
    match: null,
  }
}

export async function readChatScreen(
  settings: AppSettings | null | undefined,
  options: {
    signal?: AbortSignal
    /** `reading` carries the captured window, known from then on. */
    onPhase?: (phase: ScreenPhase, anchor?: ScreenAnchor) => void
  } = {},
  deps: ScreenCopilotDeps = defaultScreenCopilotDeps
): Promise<ScreenRead> {
  const { signal, onPhase } = options
  onPhase?.("capturing")
  let capture: FrontmostWindowCapture
  try {
    capture = await deps.capture()
  } catch (error) {
    throw new ScreenCopilotError(classifyCaptureError(error))
  }
  signal?.throwIfAborted()
  // A blanked frame has nothing to read, and saying so beats "no messages".
  if (capture.redacted) throw new ScreenCopilotError("credential_window")

  const anchor: ScreenAnchor = { ...capture.logicalBounds, scale: capture.scaleFactor }
  onPhase?.("reading", anchor)
  let text: { providerId: string; lines: ScreenLine[] }
  try {
    text = await deps.readText(capture.screenshot, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ScreenCopilotError(
      error instanceof LocalOcrUnavailableError ? "no_local_ocr" : "ocr_failed",
      error instanceof Error ? error.message : String(error)
    )
  }

  const app = resolveChatApp({ appName: capture.appName, bundleId: capture.bundleId })
  const shot = capture.screenshot
  const grouped = groupBubbles({
    lines: text.lines,
    frame: { width: shot.sourceWidth ?? shot.width, height: shot.sourceHeight ?? shot.height },
    composer: composerInFrame(capture),
    layout: app.layout,
  })
  if (grouped.bubbles.length === 0) throw new ScreenCopilotError("no_messages")
  const screen = buildScreenTranscript(grouped.bubbles, app.layout)

  const titleCandidate =
    capture.windowTitle && capture.windowTitle.trim() !== capture.appName.trim()
      ? capture.windowTitle
      : null
  const contact = await matchContact([grouped.header, titleCandidate], deps)
  const knowledge = await gatherKnowledge(
    {
      transcript: screen.transcript,
      contact: contact.match?.kind === "match" ? contact.match.primary : null,
      // No session here: the copilot memory opt-in and the global memory
      // policy decide, exactly as for a session with default memory use.
      memoryAllowed: copilotMemoryAllowed({}, settings),
    },
    { recall: (query) => deps.recall(settings, query) }
  )
  signal?.throwIfAborted()

  return {
    app: {
      name: capture.appName,
      windowTitle: capture.windowTitle,
      id: app.id,
      layout: app.layout,
    },
    anchor,
    transcript: screen.transcript,
    unsidedReason: screen.unsidedReason,
    bubbleCount: screen.bubbleCount,
    contact: contact.status,
    knowledge,
    ocrProviderId: text.providerId,
  }
}

/** Judge + draft + rank over a read, optionally steered by the user. */
export async function draftForScreen(
  read: ScreenRead,
  settings: AppSettings | null | undefined,
  options: { instructions?: string; signal?: AbortSignal } = {},
  deps: ScreenCopilotDeps = defaultScreenCopilotDeps
): Promise<CopilotResult> {
  return deps.runCopilot({
    transcript: read.transcript,
    knowledge: read.knowledge,
    instructions: options.instructions ?? "",
    client: deps.buildClient(settings),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}
