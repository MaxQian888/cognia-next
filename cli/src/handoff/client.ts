/**
 * CLI→desktop handoff client.
 *
 * Detects a running desktop via the loopback endpoint file + a `/health` ping,
 * then POSTs a session transcript to `/api/v1/dev/sessions/handoff`. The
 * desktop materialises it (`importHandoffSession`) and opens it. All IO
 * (filesystem + fetch) is injected so this unit-tests without a live desktop.
 */

import os from "node:os"
import fs from "node:fs"

import { endpointFilePath, parseEndpoint, type BridgeEndpoint } from "./endpoint"

export const DEV_TOKEN_HEADER = "X-Cognia-Dev-Token"
export const HEALTH_PATH = "/api/v1/dev/health"
export const HANDOFF_PATH = "/api/v1/dev/sessions/handoff"

export interface HandoffMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface HandoffPayload {
  sessionId: string
  title?: string
  messages: HandoffMessage[]
  meta?: { provider?: string; model?: string; cwd?: string }
}

export interface HandoffClientDeps {
  /** Reads a file's text or null when missing. */
  readFile?: (absPath: string) => string | null
  fetch?: typeof fetch
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  homedir?: string
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

function resolveEndpoint(deps: HandoffClientDeps): BridgeEndpoint | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const homedir = deps.homedir ?? os.homedir()
  const readFile = deps.readFile ?? defaultReadFile
  const file = endpointFilePath(platform, env, homedir)
  return parseEndpoint(readFile(file))
}

/**
 * Resolve the endpoint file AND confirm the bridge is actually alive (the file
 * can be stale after the desktop quits). Returns the endpoint or null.
 */
export async function detectDesktop(deps: HandoffClientDeps = {}): Promise<BridgeEndpoint | null> {
  const endpoint = resolveEndpoint(deps)
  if (!endpoint) return null
  const doFetch = deps.fetch ?? fetch
  try {
    const res = await doFetch(`${endpoint.baseUrl}${HEALTH_PATH}`, {
      headers: { [DEV_TOKEN_HEADER]: endpoint.devToken },
    })
    if (!res.ok) return null
    return endpoint
  } catch {
    return null
  }
}

export interface HandoffResult {
  ok: boolean
  sessionId: string
}

/** POST a transcript to the running desktop. Throws on a non-2xx / network error. */
export async function pushHandoff(
  endpoint: BridgeEndpoint,
  payload: HandoffPayload,
  deps: HandoffClientDeps = {}
): Promise<HandoffResult> {
  const doFetch = deps.fetch ?? fetch
  const res = await doFetch(`${endpoint.baseUrl}${HANDOFF_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [DEV_TOKEN_HEADER]: endpoint.devToken,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`handoff failed: HTTP ${res.status}`)
  }
  return { ok: true, sessionId: payload.sessionId }
}
