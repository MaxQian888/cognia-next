/**
 * CLI→desktop handoff client.
 *
 * Detects a running desktop via the loopback endpoint file + a `/health` ping,
 * then POSTs a session transcript to `/api/dev/sessions/handoff`. The
 * desktop materialises it (`importHandoffSession`) and opens it. All IO
 * (filesystem + fetch) is injected so this unit-tests without a live desktop.
 */

import os from "node:os"
import fs from "node:fs"

import { endpointFilePath, parseEndpoint, type BridgeEndpoint } from "./endpoint"

export const DEV_TOKEN_HEADER = "X-Cognia-Dev-Token"
export const HEALTH_PATH = "/api/dev/health"
export const HANDOFF_PATH = "/api/dev/sessions/handoff"

export interface HandoffMessage {
  role: "user" | "assistant" | "system"
  content: string
  id?: string
  parts?: import("ai").UIMessage["parts"]
  metadata?: import("ai").UIMessage["metadata"]
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
  healthTimeoutMs?: number
  /** Longer than the desktop renderer's 30-second persistence deadline. */
  requestTimeoutMs?: number
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
      signal: AbortSignal.timeout(deps.healthTimeoutMs ?? 3_000),
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
  const signal = AbortSignal.timeout(deps.requestTimeoutMs ?? 35_000)
  try {
    const res = await doFetch(`${endpoint.baseUrl}${HANDOFF_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEV_TOKEN_HEADER]: endpoint.devToken,
      },
      body: JSON.stringify(payload),
      signal,
    })
    let body: {
      ok?: boolean
      error?: unknown
      result?: { sessionId?: unknown; persisted?: boolean }
    } | null = null
    try {
      body = await res.json()
    } catch {
      // HTTP failures can be plain text (for example, an oversized body).
      if (signal.aborted) throw signal.reason
    }
    if (!res.ok) {
      const detail = typeof body?.error === "string" ? `: ${body.error}` : ""
      throw new Error(`handoff failed: HTTP ${res.status}${detail}`)
    }
    if (
      body?.ok !== true ||
      body.result?.persisted !== true ||
      typeof body.result.sessionId !== "string" ||
      !body.result.sessionId.trim()
    ) {
      throw new Error("handoff failed: desktop did not confirm persisted import")
    }
    return { ok: true, sessionId: body.result.sessionId }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        "handoff timed out before persistence was confirmed. Retry the same snapshot to recover the existing import without overwriting later work."
      )
    }
    throw error
  }
}
