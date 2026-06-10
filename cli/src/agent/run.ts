/**
 * Headless agent turn orchestrator.
 *
 * Wires the reuse seams end to end:
 *   config → toBuildContext → resolveSendOptions (REUSED desktop assembly)
 *   → bootstrap sidecar (StdioTransport) → runAndCaptureAssistantReply (REUSED)
 *   → transcript.
 *
 * Every collaborator is injectable so the orchestration unit-tests without a
 * live sidecar or model.
 */

import os from "node:os"

import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import {
  runAndCaptureAssistantReply as defaultCapture,
  type RunAndCaptureResult,
  type CaptureStreamEvent,
} from "@/lib/claude/run-and-capture"
import type { SendOptions } from "@/lib/claude/types"

import { resolveHome } from "../config/load"
import { type ResolvedConfig } from "../config/schema"
import { toBuildContext } from "../config/to-build-context"
import { bootstrapSidecar, type SidecarBootstrap } from "../runtime/bootstrap"
import { type PermissionResponder } from "./permission-gate"
import { appendTranscript, type TranscriptFs } from "./transcript"

/** Mint a session id matching the desktop's `s_<base36ts><rand>` convention. */
export function mintSessionId(now: number = Date.now(), rand: number = Math.random()): string {
  return `s_${now.toString(36)}${rand.toString(36).slice(2, 8)}`
}

export interface RunHeadlessParams {
  config: ResolvedConfig
  prompt: string
  /** Reuse an existing session id (resume/handoff); minted when omitted. */
  sessionId?: string
  /** Permission responder (from `createPermissionGate`). */
  gate: PermissionResponder
  /** Incremental stream events for rendering. */
  onEvent?: (event: CaptureStreamEvent) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** CLI home for the transcript; defaults to `resolveHome(process.env, os.homedir())`. */
  home?: string

  // ---- Injected collaborators (tests / advanced wiring) ------------------
  bootstrap?: (cwd: string) => Promise<SidecarBootstrap>
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  capture?: typeof defaultCapture
  transcriptFs?: TranscriptFs
  now?: number
}

export interface RunHeadlessResult {
  sessionId: string
  text: string
  usage?: RunAndCaptureResult["usage"]
  sdkSessionId?: string
}

/** Run one headless agent turn and return its captured reply. */
export async function runHeadlessTurn(params: RunHeadlessParams): Promise<RunHeadlessResult> {
  const now = params.now ?? Date.now()
  const sessionId = params.sessionId ?? mintSessionId(now)
  const home = params.home ?? resolveHome(process.env, os.homedir())

  const ctx = toBuildContext({ sessionId, config: params.config, now })
  const resolveOptions = params.resolveOptions ?? defaultResolveSendOptions
  const options = await resolveOptions(ctx)

  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))
  const boot = await bootstrap(params.config.cwd)

  const capture = params.capture ?? defaultCapture
  try {
    appendTranscript(
      home,
      sessionId,
      { role: "user", content: params.prompt },
      params.transcriptFs,
      now
    )
    const result = await capture(sessionId, params.prompt, options, {
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      onPermissionRequest: params.gate,
      onEvent: params.onEvent,
    })
    appendTranscript(
      home,
      sessionId,
      {
        role: "assistant",
        content: result.text,
        meta: {
          model: options.model,
          provider: options.provider,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}),
        },
      },
      params.transcriptFs,
      params.now ?? Date.now()
    )
    return {
      sessionId,
      text: result.text,
      usage: result.usage,
      sdkSessionId: result.sdkSessionId,
    }
  } finally {
    await boot.shutdown()
  }
}
