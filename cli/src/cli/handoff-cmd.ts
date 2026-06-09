/**
 * `cognia-agent handoff <sessionId>` — push a CLI session to the running
 * desktop app to continue there.
 * `cognia-agent resume <id> "<prompt>"` — continue a session the desktop handed
 * back (written to ~/.cognia/handoff/<id>.jsonl) in the terminal.
 *
 * Also exposes `maybePushHandoff` used by `run --handoff`.
 */

import os from "node:os"
import path from "node:path"
import fs from "node:fs"

import { resolveHome } from "../config/load"
import { loadConfig as defaultLoadConfig } from "../config/load"
import {
  readTranscript as defaultReadTranscript,
  type TranscriptEntry,
  type TranscriptFs,
} from "../agent/transcript"
import {
  detectDesktop as defaultDetect,
  pushHandoff as defaultPush,
  type HandoffMessage,
  type HandoffPayload,
} from "../handoff/client"
import { createPermissionGate } from "../agent/permission-gate"
import { runHeadlessTurn as defaultRun } from "../agent/run"
import { renderTranscript } from "@/lib/chat/branch-session"
import type { UIMessage } from "ai"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

/** Where the desktop drops a session for `resume` (app→CLI direction). */
export const HANDOFF_DROP_DIR = "handoff"

export function handoffDropPath(home: string, sessionId: string): string {
  return path.join(home, HANDOFF_DROP_DIR, `${sessionId}.jsonl`)
}

function entriesToMessages(entries: TranscriptEntry[]): HandoffMessage[] {
  return entries.map((e) => ({ role: e.role, content: e.content }))
}

function metaFromEntries(entries: TranscriptEntry[]): HandoffPayload["meta"] {
  for (const e of entries) {
    const m = e.meta as { provider?: string; model?: string } | undefined
    if (m?.provider || m?.model) return { provider: m.provider, model: m.model }
  }
  return undefined
}

export interface HandoffDeps {
  home?: string
  out?: OutputSink
  readTranscript?: typeof defaultReadTranscript
  detectDesktop?: typeof defaultDetect
  pushHandoff?: typeof defaultPush
  env?: Record<string, string | undefined>
}

/**
 * Push a session's transcript to the desktop if one is running. Returns true on
 * success; logs an actionable notice (and returns false) when no desktop is
 * reachable or the transcript is empty. Never throws — used inline by `run`.
 */
export async function maybePushHandoff(
  sessionId: string,
  title: string | undefined,
  deps: HandoffDeps = {}
): Promise<boolean> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const readTranscript = deps.readTranscript ?? defaultReadTranscript
  const detect = deps.detectDesktop ?? defaultDetect
  const push = deps.pushHandoff ?? defaultPush

  const entries = readTranscript(home, sessionId)
  if (entries.length === 0) {
    out.error(`handoff: no transcript for session ${sessionId}`)
    return false
  }
  const endpoint = await detect()
  if (!endpoint) {
    out.error("handoff: no running Cognia desktop found (open the app, then retry)")
    return false
  }
  try {
    await push(endpoint, {
      sessionId,
      title,
      messages: entriesToMessages(entries),
      meta: metaFromEntries(entries),
    })
    out.write(`Handed off session ${sessionId} to the desktop app.\n`)
    return true
  } catch (err) {
    out.error(`handoff failed: ${(err as Error).message}`)
    return false
  }
}

/** `handoff <sessionId>` command. */
export async function handoffCommand(args: ParsedArgs, deps: HandoffDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const sessionId = args.positionals[0]
  if (!sessionId) {
    out.error("handoff: usage — cognia-agent handoff <sessionId>")
    return 2
  }
  const ok = await maybePushHandoff(sessionId, stringFlag(args, "title"), deps)
  return ok ? 0 : 1
}

export interface ResumeDeps {
  home?: string
  out?: OutputSink
  loadConfig?: (
    flags?: Parameters<typeof defaultLoadConfig>[0]
  ) => ReturnType<typeof defaultLoadConfig>
  run?: typeof defaultRun
  readDrop?: (absPath: string) => string | null
  transcriptFs?: TranscriptFs
  env?: Record<string, string | undefined>
}

function defaultReadDrop(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/**
 * `resume <id> "<prompt>"` — load a transcript the desktop dropped for the CLI
 * and continue it in the terminal. The prior transcript is re-injected as
 * context (snapshot resume; the CLI runs a fresh sidecar).
 */
export async function resumeCommand(args: ParsedArgs, deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const readDrop = deps.readDrop ?? defaultReadDrop
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  const run = deps.run ?? defaultRun

  const id = args.positionals[0]
  if (!id) {
    out.error('resume: usage — cognia-agent resume <id> "<prompt>"')
    return 2
  }
  const prompt = args.positionals.slice(1).join(" ").trim()
  if (!prompt) {
    out.error("resume: a prompt is required to continue the session")
    return 2
  }

  const raw = readDrop(handoffDropPath(home, id))
  if (raw === null) {
    out.error(`resume: no handed-off session "${id}" (expected ${handoffDropPath(home, id)})`)
    return 2
  }
  const priorEntries: TranscriptEntry[] = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TranscriptEntry)
  const priorMessages: UIMessage[] = priorEntries.map(
    (e, i) =>
      ({ id: `m_${i}`, role: e.role, parts: [{ type: "text", text: e.content }] }) as UIMessage
  )
  const transcript = renderTranscript(priorMessages)

  let config: ReturnType<typeof defaultLoadConfig>
  try {
    config = loadConfig()
  } catch (err) {
    out.error(`config error: ${(err as Error).message}`)
    return 2
  }

  // Re-inject prior context as a preamble — the desktop's session lived in a
  // different sidecar process, so there is no sdkSessionId to resume across.
  const composedPrompt = transcript
    ? `Continuing a prior session. Earlier conversation:\n\n${transcript}\n\n---\n\n${prompt}`
    : prompt

  try {
    const result = await run({
      config,
      prompt: composedPrompt,
      sessionId: id,
      gate: createPermissionGate({ yes: boolFlag(args, "yes") }),
      home,
      transcriptFs: deps.transcriptFs,
      onEvent: (event) => {
        if (event.type === "text-delta" && event.delta) out.write(event.delta)
      },
    })
    out.write("\n")
    return result.text !== undefined ? 0 : 1
  } catch (err) {
    out.error(`resume failed: ${(err as Error).message}`)
    return 1
  }
}
