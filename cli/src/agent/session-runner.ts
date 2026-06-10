/**
 * Persistent multi-turn agent session — the core behind the interactive TUI.
 *
 * Unlike `runHeadlessTurn` (bootstrap → one turn → shutdown), this bootstraps
 * the sidecar ONCE and keeps it alive, so every `send()` reuses the same
 * `sessionId`. The sidecar keeps that SDK session open (it `pushUserMessage`s
 * follow-ups), so context accumulates in-process across turns — exactly the
 * desktop chat behaviour, reused unchanged.
 *
 * Collaborators are injected so the multi-turn orchestration unit-tests without
 * a live sidecar or model.
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
import { mintSessionId } from "./run"
import { type PermissionResponder } from "./permission-gate"
import { appendTranscript, type TranscriptFs } from "./transcript"

export interface AgentSessionParams {
  config: ResolvedConfig
  sessionId?: string
  home?: string
  bootstrap?: (cwd: string) => Promise<SidecarBootstrap>
  resolveOptions?: (ctx: BuildOptionsContext) => Promise<SendOptions>
  capture?: typeof defaultCapture
  transcriptFs?: TranscriptFs
  now?: () => number
}

export interface SendTurnOptions {
  gate: PermissionResponder
  onEvent?: (event: CaptureStreamEvent) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export interface AgentSession {
  readonly sessionId: string
  send(prompt: string, opts: SendTurnOptions): Promise<RunAndCaptureResult>
  close(): Promise<void>
}

/**
 * Create a persistent agent session. Lazy: the sidecar spawns + options resolve
 * on the first `send`. Subsequent sends reuse both.
 */
export function createAgentSession(params: AgentSessionParams): AgentSession {
  const now = params.now ?? Date.now
  const sessionId = params.sessionId ?? mintSessionId(now())
  const home = params.home ?? resolveHome(process.env, os.homedir())
  const resolveOptions = params.resolveOptions ?? defaultResolveSendOptions
  const capture = params.capture ?? defaultCapture
  const bootstrap =
    params.bootstrap ?? ((cwd: string) => bootstrapSidecar({ cwd, env: process.env }))

  let boot: SidecarBootstrap | null = null
  let options: SendOptions | null = null
  let closed = false

  async function ensureReady(): Promise<SendOptions> {
    if (closed) throw new Error("agent session is closed")
    if (!options) {
      const ctx = toBuildContext({ sessionId, config: params.config, now: now() })
      options = await resolveOptions(ctx)
    }
    if (!boot) {
      boot = await bootstrap(params.config.cwd)
    }
    return options
  }

  return {
    sessionId,
    async send(prompt, opts) {
      const sendOptions = await ensureReady()
      appendTranscript(
        home,
        sessionId,
        { role: "user", content: prompt },
        params.transcriptFs,
        now()
      )
      const result = await capture(sessionId, prompt, sendOptions, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onPermissionRequest: opts.gate,
        onEvent: opts.onEvent,
      })
      appendTranscript(
        home,
        sessionId,
        {
          role: "assistant",
          content: result.text,
          meta: {
            model: sendOptions.model,
            provider: sendOptions.provider,
            ...(result.usage ? { usage: result.usage } : {}),
          },
        },
        params.transcriptFs,
        now()
      )
      return result
    },
    async close() {
      if (closed) return
      closed = true
      if (boot) await boot.shutdown()
    },
  }
}
