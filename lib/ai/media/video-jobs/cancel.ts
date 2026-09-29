/**
 * Remote cancel for providers that expose one.
 *
 * The AI SDK video interface has no cancel, so each call below is the
 * vendor's own REST endpoint, built from the `operation` the SDK adapter
 * returned (shapes read from `@ai-sdk/{replicate,fal,bytedance,alibaba}`
 * `doStart`). A provider absent from the table — Google Veo (its long-running
 * operations for video cannot be cancelled) and xAI (no documented cancel) —
 * gets a local stop only, and the UI says the provider may still finish and
 * bill.
 *
 * Every URL is checked against the provider's configured origin (or fal's
 * queue host) before the API key is attached, so a malformed row can never
 * send a credential elsewhere.
 */

import type { JSONValue } from "ai"

import type { VideoProviderId } from "../video-generation-sdk"

export interface RemoteCancelRequest {
  url: string
  method: "POST" | "PUT" | "DELETE"
  headers: Record<string, string>
}

export interface RemoteCancelContext {
  operation: JSONValue
  apiKey: string | undefined
  /** The base URL the job's status checks use (see `VideoJobProvider`). */
  baseURL: string | undefined
}

type CancelBuilder = (context: RemoteCancelContext) => RemoteCancelRequest | null

function field(operation: JSONValue, key: string): string | undefined {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return undefined
  const value = (operation as Record<string, JSONValue>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function sameOrigin(url: string, base: string | undefined): boolean {
  if (!base) return false
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}

function joinPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`
}

const bearer = (apiKey: string | undefined): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {}

/** DashScope (Qwen Wan) task base: the `videoBaseURL` the adapter uses. */
function dashScopeBase(baseURL: string | undefined): string | undefined {
  return baseURL?.replace(/\/compatible-mode\/v1\/?$/, "")
}

const REMOTE_VIDEO_CANCEL: Partial<Record<VideoProviderId, CancelBuilder>> = {
  // Replicate: POST {prediction get URL}/cancel.
  replicate: ({ operation, apiKey, baseURL }) => {
    const getUrl = field(operation, "getUrl")
    if (!getUrl || !sameOrigin(getUrl, baseURL)) return null
    return { url: `${getUrl.replace(/\/+$/, "")}/cancel`, method: "POST", headers: bearer(apiKey) }
  },
  // fal queue: PUT {response URL}/cancel with a `Key` credential.
  fal: ({ operation, apiKey }) => {
    const responseUrl = field(operation, "responseUrl")
    if (!responseUrl) return null
    try {
      if (new URL(responseUrl).hostname !== "queue.fal.run") return null
    } catch {
      return null
    }
    return {
      url: `${responseUrl.replace(/\/+$/, "")}/cancel`,
      method: "PUT",
      headers: apiKey ? { Authorization: `Key ${apiKey}` } : ({} as Record<string, string>),
    }
  },
  // Volcengine Ark (Seedance): DELETE the queued generation task.
  doubao: ({ operation, apiKey, baseURL }) => {
    const taskId = field(operation, "taskId")
    if (!taskId || !baseURL) return null
    return {
      url: joinPath(baseURL, `/contents/generations/tasks/${encodeURIComponent(taskId)}`),
      method: "DELETE",
      headers: bearer(apiKey),
    }
  },
  volcengine: (context) => REMOTE_VIDEO_CANCEL.doubao!(context),
  // DashScope: POST /api/v1/tasks/{id}/cancel (honored while still pending).
  qwen: ({ operation, apiKey, baseURL }) => {
    const taskId = field(operation, "taskId")
    const base = dashScopeBase(baseURL)
    if (!taskId || !base) return null
    return {
      url: joinPath(base, `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`),
      method: "POST",
      headers: bearer(apiKey),
    }
  },
}

/** Whether cancelling a job on this provider actually stops it remotely. */
export function supportsRemoteVideoCancel(providerId: VideoProviderId): boolean {
  return REMOTE_VIDEO_CANCEL[providerId] !== undefined
}

export function buildRemoteVideoCancel(
  providerId: VideoProviderId,
  context: RemoteCancelContext
): RemoteCancelRequest | null {
  return REMOTE_VIDEO_CANCEL[providerId]?.(context) ?? null
}
